require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalFollow, GoalBlock } = goals
const mcDataLoader = require('minecraft-data')
const { Vec3 } = require('vec3')
const fetch = global.fetch || (() => { try { return require('node-fetch'); } catch(e) { return null } })()

// sendChatCompletion: call local GPT4All HTTP API similar to test.js (supports Authorization and model name)
async function sendChatCompletion({ model, messages, temperature = 0.3, max_tokens = null }) {
  if (!fetch) throw new Error('fetch not available; install node-fetch or run Node 18+')
  const url = process.env.GPT4ALL_URL || 'http://127.0.0.1:4891/v1/chat/completions'
  const apiKey = process.env.GPT4ALL_API_KEY || process.env.OPENAI_API_KEY || null
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  // allow configuring max tokens via parameter or environment variables
  const DEFAULT_MAX_TOKENS = Number(process.env.GPT4ALL_MAX_TOKENS) || 2048
  const MULTIPLIER = Number(process.env.GPT4ALL_TOKEN_MULTIPLIER) || 5 // default: give ~5x tokens
  const finalMaxTokens = (typeof max_tokens === 'number' && !isNaN(max_tokens)) ? max_tokens : Math.min(DEFAULT_MAX_TOKENS * MULTIPLIER, 32768)
  // send a minimal compatible payload; local endpoints often reject non-standards args — include max_tokens to request longer outputs
  const body = { model: model || process.env.GPT4ALL_MODEL || 'Llama 3 8B Instruct', messages, temperature, max_tokens: finalMaxTokens }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch (e) { json = text }
  if (json && json.error) {
    try { console.error('LLM API error:', json.error) } catch (e) {}
    return { choices: [{ message: { content: '' } }] }
  }
  // normalize to choices[0].message.content where possible
  if (json && Array.isArray(json.choices) && json.choices[0] && json.choices[0].message && json.choices[0].message.content) return json
  if (json && typeof json.text === 'string') return { choices: [{ message: { content: json.text } }] }
  if (typeof json === 'string') return { choices: [{ message: { content: json } }] }
  return json
}

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost', 
  port: Number(process.env.MC_PORT ||  25565),  
  username: process.env.MC_USERNAME || 'AI',
  version: process.env.MC_VERSION || false,
  auth: process.env.MC_AUTH || 'offline'
})

bot.loadPlugin(pathfinder)

let mcData
let moves
let running = true
let busy = false
let currentTask = null
let loopTimer = null
let knownBlocks = new Map()
let inventoryMap = {}
let botIsOp = true
let duelTarget = null
let duelInterval = null
let lastHealth = null

const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE === '1' || true
const ALLOW_COMMANDS = process.env.ALLOW_COMMANDS === '1' || true
const OWNER_USERNAME = process.env.MC_OWNER || null

function now() { return Date.now() }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function setBusy(state, name = null) { busy = state; currentTask = state ? name : null }
function posKey(p) { return `${p.x},${p.y},${p.z}` }

function rememberBlock(b) {
  if (!b) return
  knownBlocks.set(posKey(b.position), { id: b.type, name: b.name, position: b.position, metadata: b.metadata })
}

function forgetBlockAt(pos) {
  knownBlocks.delete(posKey(pos))
}

function scanNearby(radius = 24) {
  const origin = bot.entity.position.floored()
  const found = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -8; dy <= 8; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = origin.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (b) {
          rememberBlock(b)
          found.push(b)
        }
      }
    }
  }
  return found
}

function findKnownBlockByName(name, radius = 24) {
  const origin = bot.entity.position
  let best = null
  let bestDist = Infinity
  for (const v of knownBlocks.values()) {
    if (!v || !v.name) continue
    if (v.name === name || v.name.includes(name)) {
      const d = origin.distanceTo(v.position)
      if (d < bestDist && d <= radius) { best = v; bestDist = d }
    }
  }
  return best
}

function refreshInventory() {
  inventoryMap = {}
  for (const it of bot.inventory.items()) {
    inventoryMap[it.name] = (inventoryMap[it.name] || 0) + it.count
  }
  return inventoryMap
}

// keep inventory and nearby blocks reasonably up-to-date
setInterval(() => { try { refreshInventory(); scanNearby(16) } catch (e) {} }, 2000)

bot.on('blockUpdate', (oldBlock, newBlock) => {
  if (newBlock && newBlock.type !== 0) rememberBlock(newBlock)
  if (oldBlock && (!newBlock || newBlock.type === 0)) forgetBlockAt(oldBlock.position)
})

bot.on('chunkColumnLoad', (chunkX, chunkZ) => {
  try { scanNearby(32) } catch (e) {}
})

async function stopMovement() {
  try { bot.pathfinder.stop() } catch {}
  await sleep(150)
}

async function gotoNear(pos, range = 1) {
  return new Promise((resolve) => {
    bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, range))
    const onArrive = () => { cleanup(); resolve(true) }
    const onCannot = () => { cleanup(); resolve(false) }
    function cleanup() {
      bot.removeListener('goal_reached', onArrive)
      bot.removeListener('cannotFind', onCannot)
    }
    bot.once('goal_reached', onArrive)
    bot.once('cannotFind', onCannot)
  })
}

async function lookAtCenter(pos) {
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5))
}

function findNearestBlocks(names, radius = 24) {
  const origin = bot.entity.position.floored()
  const blocks = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -8; dy <= 8; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = origin.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (b && names.includes(b.name)) blocks.push(b)
      }
    }
  }
  blocks.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  return blocks
}

function findNearbyBlock(names, radius = 10) {
  return findNearestBlocks(names, radius)[0] || null
}

function hasItem(names, min = 1) {
  const items = bot.inventory.items()
  let count = 0
  for (const n of names) {
    for (const i of items) if (i.name === n) count += i.count
  }
  return count >= min
}

function countItem(names) {
  const items = bot.inventory.items()
  let count = 0
  for (const n of names) {
    for (const i of items) if (i.name === n) count += i.count
  }
  return count
}

function findItem(name) {
  return bot.inventory.items().find(i => i.name === name) || null
}

async function equipPrefer(names) {
  for (const n of names) {
    const it = findItem(n)
    if (it) {
      try { await bot.equip(it, 'hand'); return true } catch {}
    }
  }
  return false
}

async function pickupNearbyItems(timeoutMs = 4000) {
  const start = now()
  while (now() - start < timeoutMs) {
    const items = Object.values(bot.entities)
      .filter(e => e && (e.kind === 'item' || e.type === 'object' || (typeof e.displayName === 'string' && e.displayName.toLowerCase().includes('item'))))
    if (!items.length) { await sleep(250); continue }
    items.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
    const target = items[0]
    await gotoNear(target.position, 1)
    await sleep(200)
  }
}

async function safeDig(block) {
  if (!block || block.name === 'air') return false
  setBusy(true, 'dig')
  try {
    await stopMovement()
    await lookAtCenter(block.position)
    await bot.dig(block)
    await pickupNearbyItems(2000)
    return true
  } catch { return false }
  finally { setBusy(false) }
}

async function safePlace(referenceBlock, faceVec3, itemName) {
  if (!referenceBlock) return false
  const item = findItem(itemName)
  if (!item) return false
  setBusy(true, 'place')
  try {
    await stopMovement()
    await bot.equip(item, 'hand')
    await bot.placeBlock(referenceBlock, faceVec3)
    return true
  } catch { return false }
  finally { setBusy(false) }
}

async function dropItemsToPlayer(username, names) {
  const target = bot.players[username]?.entity
  if (!target) return false
  await gotoNear(target.position, 1)
  for (const n of Array.isArray(names) ? names : [names]) {
    const stacks = bot.inventory.items().filter(i => i.name === n || i.name.includes(n))
    for (const st of stacks) { try { await bot.tossStack(st) } catch {} await sleep(100) }
  }
  return true
}

async function craftPlanks(targetAdditional = 8) {
  const woods = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','bamboo_block']
  let crafted = 0
  for (const w of woods) {
    const plankName = w.includes('bamboo') ? 'bamboo_planks' :
      w.includes('dark_oak') ? 'dark_oak_planks' :
      w.includes('cherry') ? 'cherry_planks' :
      w.includes('mangrove') ? 'mangrove_planks' :
      w.includes('acacia') ? 'acacia_planks' :
      w.includes('spruce') ? 'spruce_planks' :
      w.includes('birch') ? 'birch_planks' : 'oak_planks'
    const plankId = mcData.itemsByName[plankName]?.id
    if (!plankId) continue
    // use bot.recipesFor to find a recipe for the target item
    const recipes = bot.recipesFor(plankId, null, 1, null)
    const recipe = Array.isArray(recipes) ? recipes[0] : null
    if (!recipe) continue
    try { await bot.craft(recipe, 1, null); crafted += 4; if (crafted >= targetAdditional) break } catch {}
  }
  return crafted > 0
}

let workbenchPos = null
async function ensureWorkbench() {
  const existing = findNearbyBlock(['crafting_table'], 6)
  if (existing) { workbenchPos = existing.position; return true }
  if (!findItem('crafting_table')) {
    const planks = countItem(['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks'])
    if (planks < 4) { const ok = await craftPlanks(4 - planks); if (!ok) return false }
    const tableId = mcData.itemsByName['crafting_table']?.id
    if (!tableId) return false
    // use bot.recipesFor to find recipe for crafting_table
    const recipes = bot.recipesFor(tableId, null, 1, null)
    const recipe = Array.isArray(recipes) ? recipes[0] : null
    if (!recipe) return false
    try { await bot.craft(recipe, 1, null) } catch { return false }
  }
  const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  if (!ref) return false
  const placed = await safePlace(ref, new Vec3(0, 1, 0), 'crafting_table')
  if (placed) { workbenchPos = ref.position.offset(0, 1, 0); return true }
  return false
}

async function craftAtTable(resultName, count) {
  const tbl = workbenchPos ? bot.blockAt(workbenchPos) : findNearbyBlock(['crafting_table'], 6)
  if (!tbl) { const ok = await ensureWorkbench(); if (!ok) return false }
  const tableBlock = workbenchPos ? bot.blockAt(workbenchPos) : findNearbyBlock(['crafting_table'], 6)
  if (!tableBlock) return false
  const id = mcData.itemsByName[resultName]?.id
  if (!id) return false
  // use bot.recipesFor to find a recipe suitable for the table
  const recipes = bot.recipesFor(id, null, 1, tableBlock.type)
  const recipe = Array.isArray(recipes) ? recipes[0] : null
  if (!recipe) return false
  try { await bot.craft(recipe, count, tableBlock); return true } catch { return false }
}

async function craftSticks(count = 2) {
  const id = mcData.itemsByName['stick']?.id
  if (!id) return false
  // use bot.recipesFor to find stick recipe
  const recipes = bot.recipesFor(id, null, 1, null)
  const recipe = Array.isArray(recipes) ? recipes[0] : null
  if (!recipe) return false
  try { await bot.craft(recipe, count, null); return true } catch { return false }
}

async function ensureWoodPick() {
  if (findItem('wooden_pickaxe')) return true
  if (countItem(['stick']) < 2) { const ok = await craftSticks(2); if (!ok) return false }
  if (countItem(['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks']) < 3) {
    const ok = await craftPlanks(3); if (!ok) return false
  }
  const okTable = await ensureWorkbench(); if (!okTable) return false
  return await craftAtTable('wooden_pickaxe', 1)
}

async function ensureStonePick() {
  if (findItem('stone_pickaxe')) return true
  if (countItem(['stick']) < 2) { const ok = await craftSticks(2); if (!ok) return false }
  if (countItem(['cobblestone']) < 3) { const ok = await collectStone(6); if (!ok) return false }
  const okTable = await ensureWorkbench(); if (!okTable) return false
  return await craftAtTable('stone_pickaxe', 1)
}

async function collectWood(target = 8) {
  // Large action disabled: collectWood is a macroscopic behavior and is intentionally blocked.
  try { bot.chat('collectWood is disabled. Use micro-actions (inspect/goto/dig) and request a precise plan.') } catch (e) {}
  return false
}

async function collectStone(target = 12) {
  // Large action disabled: collectStone is a macroscopic behavior and is intentionally blocked.
  try { bot.chat('collectStone is disabled. Use micro-actions (inspect/goto/dig) and request a precise plan.') } catch (e) {}
  return false
}

async function pipelineEarly() {
  // High-level pipeline handler: ask the planner to produce a micro-action plan for the pipeline
  try { bot.chat('Received pipeline request — generating detailed micro plan...') } catch (e) {}
  const inst = 'Decompose a high-level startup pipeline into up to 10 micro-steps using only inspect/goto/dig with numeric x,y,z coords within 10 blocks. Example JSON: {"plan":{"steps":[{"name":"inspect","params":{"x":..,"y":..,"z":..},"rationale":"..."}]}}. Keep rationales short.'
  const plan = await requestPlanFromLLM(inst)
  if (plan && Array.isArray(plan.steps) && plan.steps.length) {
    try { await executePlan(plan.steps) } catch (e) { console.error('executePlan failed for pipelineEarly:', e) }
    return true
  }
  try { bot.chat('Could not generate micro-plan for pipelineEarly') } catch (e) {}
  return false
}

async function wanderSlightly() {
  const p = bot.entity.position.floored()
  const dx = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.floor(Math.random() * 6))
  const dz = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.floor(Math.random() * 6))
  const tgt = new Vec3(p.x + dx, p.y, p.z + dz)
  bot.pathfinder.setGoal(new GoalNear(tgt.x, tgt.y, tgt.z, 1))
}

async function gotoPlayer(username) {
  const t = bot.players[username]?.entity
  if (!t) return false
  return await gotoNear(t.position, 1)
}

async function plannerTick() {
  try {
    if (!running || busy) return
    // ask LLM for a short micro-action plan (inspect/goto/dig) with coords within 10 blocks
    const inst = 'Autonomous planner: produce a concise plan with a sequence of micro-steps (inspect/goto/dig). Each step must include numeric x,y,z coordinates and be within 10 blocks of the bot. Limit to at most 8 steps. For each step include a short rationale.'
    const plan = await requestPlanFromLLM(inst)
    if (plan && Array.isArray(plan.steps) && plan.steps.length) {
      try { await executePlan(plan.steps) } catch (e) { console.error('executePlan failed:', e) }
      return
    }
    // fallback small wander
    await wanderSlightly()
  } catch (e) {
    console.error('plannerTick exception:', e)
  }
}

// --- START/STOP loop helpers ---
function startLoop() {
  if (loopTimer) return
  running = true
  // run plannerTick immediately then every interval
  plannerTick().catch(e => console.error('plannerTick initial error:', e))
  const interval = Number(process.env.PLANNER_INTERVAL_MS) || 5000
  loopTimer = setInterval(() => { try { plannerTick() } catch (e) { console.error('plannerTick error:', e) } }, interval)
  try { bot.chat && bot.chat('Autonomous loop started') } catch (e) {}
}

function stopLoop() {
  running = false
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null }
  try { bot.chat && bot.chat('Autonomous loop stopped') } catch (e) {}
}

bot.once('spawn', () => {
  mcData = mcDataLoader(bot.version)
  moves = new Movements(bot, mcData)
  moves.allowFreeMotion = true
  moves.canOpenDoors = true
  moves.allow1x1towers = true
  bot.pathfinder.setMovements(moves)
  bot.chat('Bereit. Sprich mit mir. (start/stop/status)')
  startLoop()
})

// also announce on login (some servers require login before chats are accepted)
bot.on('login', () => {
  try { bot.chat('Logged in and ready.') } catch (e) {}
  // send a second readiness message a bit later to avoid race conditions
  setTimeout(() => { try { bot.chat('Bereit. Sprich mit mir. (start/stop/status)') } catch (e) {} }, 2000)
})

bot.on('chat', async (username, message) => {
  if (username === bot.username) return
  const msg = message.trim().toLowerCase()
  // allow a trusted owner to mark the bot as op (local flag) or enable command execution
  if (OWNER_USERNAME && username === OWNER_USERNAME) {
    if (msg.startsWith('setop ')) {
      const v = msg.split(' ')[1]
      botIsOp = (v === 'on' || v === 'true' || v === '1')
      bot.chat(`botIsOp=${botIsOp}`)
      return
    }
    if (msg === 'enablecommands') { botIsOp = true; bot.chat('Commands enabled for bot'); return }
    if (msg === 'disablecommands') { botIsOp = false; bot.chat('Commands disabled for bot'); return }
  }

  if (msg === 'start') { startLoop(); bot.chat('Starte.'); return }
  if (msg === 'stop')  { stopLoop();  bot.chat('Stoppe.'); return }
  if (msg === 'status') {
    bot.chat(`HP:${bot.health} Food:${bot.food} Holz:${countItem(['oak_log','birch_log','spruce_log'])} Planks:${countItem(['oak_planks','birch_planks','spruce_planks'])} Stein:${countItem(['cobblestone'])} op:${botIsOp}`)
    return
  }

  // duel / challenge commands
  if (msg === 'duel' || msg === 'duel me' || msg === 'fight me' || msg === 'challenge me' || msg === 'battle me') {
    await startDuelWith(username)
    return
  }
  if (msg.startsWith('duel ') || msg.startsWith('challenge ') || msg.startsWith('fight ') || msg.startsWith('battle ')) {
    const parts = msg.split(/\s+/)
    const target = parts[1] || username
    await startDuelWith(target)
    return
  }
  if (msg === 'stopduel' || msg === 'endduel' || msg === 'forfeit') {
    await stopDuel()
    return
  }

  // Parse simple chat commands of form: "inspect x y z", "goto x y z", "dig x y z", "command <text>"
  function parseChatCommandToActions(text, username) {
    if (!text) return []
    const t = String(text).trim()
    const simpleRe = /^(inspect|goto|dig|mine)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/i
    const m = t.match(simpleRe)
    if (m) {
      const name = m[1].toLowerCase()
      const x = Number(m[2])
      const y = Number(m[3])
      const z = Number(m[4])
      return [{ name, params: { x, y, z } }]
    }
    // /command or command: run server command
    const cmdRe = /^(?:command|cmd)\s+(.+)$/i
    const m2 = t.match(cmdRe)
    if (m2) {
      const cmd = m2[1].trim().replace(/USERNAME|USER|PLAYER/gi, username)
      return [{ name: 'command', params: { command: cmd } }]
    }
    // inline pattern: //command(time set day) or //inspect(x=1,y=64,z=-5)
    const inlineRe = /\/\/\s*([a-zA-Z0-9_]+)\s*\(([^\)]*)\)/
    const m3 = t.match(inlineRe)
    if (m3) {
      const name = m3[1].toLowerCase()
      const args = m3[2].split(',').map(s => s.trim()).filter(Boolean)
      const params = {}
      for (const a of args) {
        const kv = a.split('=').map(s => s.trim())
        if (kv.length === 2) {
          const v = kv[1].replace(/^['\"]|['\"]$/g, '')
          params[kv[0]] = isNaN(Number(v)) ? v : Number(v)
        } else if (!isNaN(Number(a))) {
          // positional numbers: x,y,z
          if (params.x === undefined) params.x = Number(a)
          else if (params.y === undefined) params.y = Number(a)
          else if (params.z === undefined) params.z = Number(a)
        }
      }
      return [{ name, params }]
    }
    return []
  }

  // call the planner/LLM but protect against failures so bot still responds
  try {
    const chatActions = parseChatCommandToActions(message, username)
    if (chatActions && chatActions.length) {
      for (const a of chatActions) {
        console.log('[gpt] executing action from chat command:', a)
        try { await executeAction(username, a) } catch (e) { console.error('executeAction failed for', a, e) }
        await sleep(150)
      }
      return
    }

    await gptPlanAndExecute(username, message)
  } catch (e) {
    console.error('LLM plan/execute error:', e)
    try { bot.chat('Error: LLM or planning failed — check the LLM service.') } catch (ee) {}
  }
})

// debug message logging to help diagnose missing chat/announcement issues
bot.on('message', (msg) => {
  try { console.log('SERVER MESSAGE:', msg.toString()) } catch (e) {}
})

bot.on('kicked', (reason) => {
  try { console.warn('Kicked from server:', reason) } catch (e) {}
  try { bot.chat && bot.chat('I was kicked: ' + String(reason).slice(0, 100)) } catch (e) {}
})

bot.on('end', () => {
  try { console.log('Connection ended') } catch (e) {}
  if (loopTimer) clearInterval(loopTimer)
})

bot.on('error', (err) => {
  try { console.error('Bot error:', err) } catch (e) {}
})

function extractActionsLoose(text, username) {
  if (!text) return []
  const acts = []

  // New: support lines like: Action: move Params: {"distance":1,"direction":"forward"}
  const actionParamsRe = /Action\s*[:\-]?\s*([a-zA-Z0-9_]+)\b[\s\S]*?Params\s*[:\-]?\s*({[\s\S]*?})/i
  let m = text.match(actionParamsRe)
  if (m && m[1]) {
    const name = m[1].toLowerCase()
    const paramsText = m[2]
    let params = {}
    try {
      params = JSON.parse(paramsText)
    } catch (e) {
      // fallback: try to parse simple key=value or key:"value" pairs
      const kv = {}
      const pairs = paramsText.replace(/^[\{\s]+|[\}\s]+$/g, '').split(/[;,\n]/)
      for (const p of pairs) {
        const part = p.trim()
        if (!part) continue
        const kvm = part.match(/([a-zA-Z0-9_]+)\s*[:=]\s*(?:['"]?)([^'"\s]+)(?:['"]?)/)
        if (kvm) kv[kvm[1]] = isNaN(Number(kvm[2])) ? kvm[2] : Number(kvm[2])
      }
      params = kv
    }
    try { if (params && typeof params === 'object') {
      // replace placeholders
      for (const k of Object.keys(params)) {
        if (typeof params[k] === 'string') params[k] = params[k].replace(/USERNAME|USER|PLAYER/gi, username)
      }
    } } catch (e) {}
    acts.push({ name, params })
  }

  // JSON-like command key: "command":"..."
  const jsonCmdRe = /["']?command["']?\s*[:=]\s*["']([^"'\n]+)["']/i
  m = text.match(jsonCmdRe)
  if (m && m[1]) {
    let cmd = m[1].trim()
    cmd = cmd.replace(/USERNAME|USER|PLAYER/gi, username)
    acts.push({ name: 'command', params: { command: cmd } })
  }
  // function-like: command(command="time set day") or command(cmd=time set day)
  const funcRe = /command\s*\(\s*(?:command\s*=\s*)?["']?([^"')]+)["']?\s*\)/i
  m = text.match(funcRe)
  if (m && m[1]) {
    let cmd = m[1].trim()
    cmd = cmd.replace(/USERNAME|USER|PLAYER/gi, username)
    acts.push({ name: 'command', params: { command: cmd } })
  }
  // inline //command(...) pattern
  const inlineRe = /\/\/[^\n]*command[^\n]*/i
  m = text.match(inlineRe)
  if (m) {
    const inner = m[0]
    const p = inner.match(/command\s*\(\s*([^\)]+)\s*\)/i)
    if (p && p[1]) {
      let body = p[1]
      const q = body.match(/['"]([^'"]+)['"]/)
      let cmd = q ? q[1] : body
      cmd = cmd.replace(/USERNAME|USER|PLAYER/gi, username).trim()
      acts.push({ name: 'command', params: { command: cmd } })
    }
  }
  if (!acts.length) return []
  // dedupe
  const seen = new Set()
  const out = []
  for (const a of acts) {
    const k = (a.name || '') + '|' + (a.params && a.params.command ? a.params.command : JSON.stringify(a.params || {}))
    if (!seen.has(k)) { seen.add(k); out.push(a) }
  }
  return out
}

// Parse a plan object from LLM reply text. Expect JSON like: { "plan": { "steps": [ {...} ] } }
function parsePlanFromReply(text) {
  if (!text) return null
  // try fenced JSON first
  const codeFenceStart = text.indexOf('```json')
  const codeFenceEnd = text.indexOf('```', codeFenceStart + 7)
  if (codeFenceStart !== -1 && codeFenceEnd !== -1) {
    const jsonText = text.slice(codeFenceStart + 7, codeFenceEnd).trim()
    try {
      const obj = JSON.parse(jsonText)
      if (obj && obj.plan && Array.isArray(obj.plan.steps)) return obj.plan
    } catch {}
  }
  // fallback: find "plan" key inline
  const planKeyIdx = text.indexOf('"plan"')
  if (planKeyIdx !== -1) {
    let start = text.lastIndexOf('{', planKeyIdx)
    if (start === -1) start = text.indexOf('{', planKeyIdx)
    if (start !== -1) {
      let depth = 0
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') {
          depth--
          if (depth === 0) {
            const jsonText = text.slice(start, i + 1)
            try {
              const obj = JSON.parse(jsonText)
              if (obj && obj.plan && Array.isArray(obj.plan.steps)) return obj.plan
            } catch {}
            break
          }
        }
      }
    }
  }
  return null
}

// Request a plan from the LLM and return the parsed plan object (or null)
async function requestPlanFromLLM(userInstruction) {
  console.log('[planner] requestPlanFromLLM userInstruction:', userInstruction.slice ? userInstruction.slice(0,200) : userInstruction)
  if (!sendChatCompletion) return null
  const SYSTEM = `You are an autonomous Minecraft planner (Llama). Output ONLY JSON containing a top-level "plan" object. The plan MUST include "steps" (array). Each step must be a primitive: inspect, goto, dig and include numeric x,y,z coordinates in params. Each step may include a short "rationale" string. All coordinates MUST be within 10 blocks of the bot. Limit steps to 8. No other high-level actions allowed.`
  const messages = [ { role: 'system', content: SYSTEM }, { role: 'user', content: userInstruction } ]
  try {
    const res = await sendChatCompletion({ model: process.env.GPT4ALL_MODEL || 'Llama 3 8B Instruct', messages, temperature: 0.12 })
    let reply = ''
    if (!res) return null
    if (typeof res === 'string') reply = res
    else if (Array.isArray(res.choices) && res.choices.length) {
      const f = res.choices[0]
      reply = (f.message && f.message.content) || f.text || (f.delta && f.delta.content) || f.content || ''
    } else if (res.text) reply = res.text
    else reply = JSON.stringify(res)

    // send a short sanitized planner reply to chat for visibility
    try {
      const chatText = sanitizeLLMReplyForChat(reply)
      if (chatText) { bot.chat && bot.chat(chatText); console.log('[planner] sent LLM planner reply to chat:', chatText) }
    } catch (e) { console.log('Failed to send planner reply to chat:', e) }

    console.log('[planner] LLM reply preview:', String(reply).slice(0,400))
    const plan = parsePlanFromReply(reply)
    console.log('[planner] parsed plan:', plan && plan.steps ? plan.steps.length : null)
    return plan
  } catch (e) {
    console.error('requestPlanFromLLM failed:', e)
    return null
  }
}

// Execute a plan steps array consisting of micro-actions
async function executePlan(steps) {
  console.log('[planner] executePlan called with steps:', Array.isArray(steps) ? steps.length : typeof steps)
  if (!Array.isArray(steps)) return false
  for (const s of steps) {
    if (!s || !s.name) continue
    const name = String(s.name).toLowerCase()
    const p = s.params || {}
    console.log(`[planner] executing step: ${name} params=${JSON.stringify(p)}`)
    // validate coordinates
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') {
      try { bot.chat(`Skipping step: missing coordinates`) } catch (e) {}
      console.log('[planner] skipping step: missing coordinates', s)
      continue
    }
    // ensure within 10 blocks
    const dist = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z))
    if (dist > 10) { try { bot.chat(`Skipping out-of-range step at ${p.x},${p.y},${p.z}`) } catch (e) {} ; console.log('[planner] skipping out-of-range step', p); continue }
    // refuse illegal step types
    if (!['inspect','goto','dig','mine'].includes(name)) {
      try { bot.chat(`Skipping unsupported step type: ${name}`) } catch (e) {}
      console.log('[planner] unsupported step type, skipping:', name)
      continue
    }
    // announce rationale then execute
    if (s.rationale) try { bot.chat(`Plan: ${s.rationale}`) } catch (e) {}
    await executeMicroAction({ name, params: p })
    await sleep(200)
  }
  return true
}

// --- micro-action executor ---
async function executeMicroAction(action) {
  const name = (action.name || '').toLowerCase()
  const p = action.params || {}
  console.log('[micro] executeMicroAction:', name, p)
  if (['goto','goto_coords','move'].includes(name)) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
    console.log('[micro] goto ->', p.x, p.y, p.z)
    return await gotoNear(new Vec3(p.x, p.y, p.z), 1)
  }
  if (name === 'inspect') {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    try { bot.chat(`Inspect: ${p.blockName || (b && b.name) || 'unknown'} at ${p.x},${p.y},${p.z}`) } catch {}
    console.log('[micro] inspect result:', !!b, b && b.name)
    return !!b
  }
  if (name === 'dig' || name === 'mine') {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!b) { console.log('[micro] dig: block not found at', p); return false }
    console.log('[micro] dig -> approaching', b.position)
    await gotoNear(b.position, 1)
    await equipPrefer(['wooden_pickaxe','stone_pickaxe','iron_pickaxe','wooden_axe','stone_axe'])
    const res = await safeDig(b)
    console.log('[micro] dig result for', p, ':', res)
    return res
  }
  return false
}

// Execute a single high-level action (wrapping micro primitives and commands)
async function executeAction(username, action) {
  if (!action || !action.name) return false
  const name = String(action.name).toLowerCase()
  const p = action.params || {}
  console.log('[exec] executeAction:', name, p)

  // commands: accept either params.command or params.cmd
  if (name === 'command' || name === 'runcommand') {
    const cmd = typeof p.command === 'string' ? p.command : (typeof p.cmd === 'string' ? p.cmd : null)
    if (!cmd) { console.log('[exec] command missing cmd param'); return false }
    // announce and try to execute
    try { bot.chat && bot.chat(`Running command: ${cmd}`) } catch (e) {}
    const ok = tryExecuteCommand(cmd)
    console.log('[exec] tryExecuteCommand returned', ok)
    if (ok) return true


    try {
      const text = String(cmd).replace(/^\//, '')
      const fakeLine = '//' + text
      const fallbackActions = parseCommandLineFromReply(fakeLine)
      if (fallbackActions && fallbackActions.length) {
        console.log('[exec] fallback parsed actions from command:', fallbackActions)
        for (const fa of fallbackActions) {
          try { await executeAction(username, fa) } catch (e) { console.error('fallback executeAction failed for', fa, e) }
          await sleep(150)
        }
        return true
      }
    } catch (e) { console.error('fallback parsing failed', e) }

    return ok
  }

  // micro primitives
  if (['inspect','goto','goto_coords','move','dig','mine'].includes(name)) {
    return await executeMicroAction({ name, params: p })
  }

  // some safe helper actions
  if (name === 'dropitems') {
    const items = Array.isArray(p.items) ? p.items : (typeof p.items === 'string' ? p.items.split(',') : [])
    const list = items.length ? items : ['oak_log','birch_log','spruce_log','cobblestone','coal']
    return await dropItemsToPlayer(username, list)
  }
  if (name === 'gotoplayer') {
    const player = typeof p.player === 'string' ? p.player : username
    return await gotoPlayer(player)
  }
  if (name === 'ensureworkbench' || name === 'crafttable') {
    return await ensureWorkbench()
  }
  if (name === 'craftwoodpickaxe' || name === 'woodpick') {
    return await ensureWoodPick()
  }
  if (name === 'craftstonepickaxe' || name === 'stonepick') {
    return await ensureStonePick()
  }
  if (name === 'status') {
    try { bot.chat(`HP:${bot.health} Food:${bot.food} Holz:${countItem(['oak_log','birch_log','spruce_log'])} Planks:${countItem(['oak_planks','birch_planks','spruce_planks'])} Stein:${countItem(['cobblestone'])} op:${botIsOp}`) } catch (e) {}
    return true
  }

  console.log('[exec] unknown action:', name)
  try { bot.chat && bot.chat(`Unknown action: ${name}`) } catch (e) {}
  return false
}

// gptPlanAndExecute: called from chat handler to convert arbitrary chat into actions
async function gptPlanAndExecute(username, message) {
  console.log('[gpt] gptPlanAndExecute called for', username, 'message:', message)
  // try to extract explicit JSON actions provided in message first
  let actions = parseJsonActionsFromReply(message)
  if (!actions || !actions.length) actions = parseCommandLineFromReply(message)

  // if none, ask LLM to produce actions
  if (!actions || !actions.length) {
    if (!sendChatCompletion) return false
    const SYSTEM = `You are a helpful Minecraft assistant (Llama). Given a user's chat message, output ONLY JSON with a top-level "actions" array. Each action must be one of: inspect, goto, dig, mine, or command. For inspect/goto/dig/mine include numeric x,y,z in params. Keep actions small and local (within 10 blocks). Example: {"actions":[{"name":"inspect","params":{"x":100,"y":64,"z":-5}},{"name":"dig","params":{"x":100,"y":64,"z":-5}}]}`
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `User ${username} said: ${message}` }]
    try {
      console.log('[gpt] requesting plan from LLM')
      const res = await sendChatCompletion({ model: process.env.GPT4ALL_MODEL || 'Llama 3 8B Instruct', messages, temperature: 0.12 })
      let reply = ''
      if (!res) return false
      if (typeof res === 'string') reply = res
      else if (Array.isArray(res.choices) && res.choices.length) {
        const f = res.choices[0]
        reply = (f.message && f.message.content) || f.text || (f.delta && f.delta.content) || f.content || ''
      } else if (res.text) reply = res.text
      else reply = JSON.stringify(res)

      // send a readable LLM reply into Minecraft chat (sanitized)
      try {
        const chatText = sanitizeLLMReplyForChat(reply)
        if (chatText) { bot.chat && bot.chat(chatText); console.log('[gpt] sent LLM reply to chat:', chatText) }
      } catch (e) { console.log('Failed to send LLM reply to chat:', e) }

      console.log('[gpt] LLM reply:', reply.slice(0, 400))
      actions = parseJsonActionsFromReply(reply) || parseCommandLineFromReply(reply) || []
      console.log('[gpt] parsed actions count:', actions.length)
    } catch (e) {
      console.error('gptPlanAndExecute sendChatCompletion failed:', e)
      return false
    }
  }

  if (!actions || !actions.length) { console.log('[gpt] no actions to run'); return false }
  // execute actions sequentially
  for (const a of actions) {
    console.log('[gpt] executing action:', a)
    try { await executeAction(username, a) } catch (e) { console.error('executeAction failed for', a, e) }
    await sleep(150)
  }
  return true
}

function parseJsonActionsFromReply(text) {
  if (!text) return null
  // try fenced JSON first
  const codeFenceStart = text.indexOf('```json')
  const codeFenceEnd = text.indexOf('```', codeFenceStart + 7)
  if (codeFenceStart !== -1 && codeFenceEnd !== -1) {
    const jsonText = text.slice(codeFenceStart + 7, codeFenceEnd).trim()
    try {
      const obj = JSON.parse(jsonText)
      if (obj && Array.isArray(obj.actions)) return obj.actions
    } catch {}
  }
  // try to find an inline JSON object containing an "actions" array
  const actionsKeyIdx = text.indexOf('"actions"')
  if (actionsKeyIdx !== -1) {
    // find the opening brace before the key
    let start = text.lastIndexOf('{', actionsKeyIdx)
    if (start === -1) start = text.indexOf('{', actionsKeyIdx)
    if (start !== -1) {
      // scan forward to find the matching closing brace
      let depth = 0
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') {
          depth--
          if (depth === 0) {
            const jsonText = text.slice(start, i + 1)
            try {
              const obj = JSON.parse(jsonText)
              if (obj && Array.isArray(obj.actions)) return obj.actions
            } catch {}
            break
          }
        }
      }
    }
  }
  return null
}

function parseCommandLineFromReply(text) {
  if (!text) return []
  const sep = text.indexOf('//')
  if (sep === -1) return []
  const line = text.slice(sep + 2).trim()
  if (!line) return []
  return line.split(';').map(cmd => {
    const m = cmd.match(/^([a-zA-Z0-9_]+)(?:\((.*)\))?$/)
    if (!m) return { name: cmd.trim(), params: {} }
    const name = m[1]
    const paramsStr = m[2]
    const params = {}
    if (paramsStr) {
      for (const entry of paramsStr.split(',')) {
        const [k, v] = entry.split('=')
        if (!k) continue
        if (!v) { params[k.trim()] = true; continue }
        if (v.includes('"') || v.includes("'")) {
          params[k.trim()] = v.replace(/^['\"]|['\"]$/g, '')
        } else if (!isNaN(Number(v))) {
          params[k.trim()] = Number(v)
        } else {
          params[k.trim()] = v.trim()
        }
      }
    }
    return { name, params }
  })
}

function sanitizeLLMReplyForChat(reply) {
  if (!reply) return ''
  // remove fenced code blocks
  let s = String(reply).replace(/```[\s\S]*?```/g, '')
  // remove large JSON objects (best-effort) to avoid spamming raw JSON
  s = s.replace(/\{[\s\S]*\}/g, '')
  // collapse whitespace and trim
  s = s.replace(/\s+/g, ' ').trim()
  // filter unwanted assistant preambles
  if (s.startsWith('"Alright, let') ) return ''

  // limit to 240 chars (Minecraft chat length limits vary)
  if (s.length > 240) s = s.slice(0, 237) + '...'
  return s
}

// Allow safe execution of server commands (used by executeAction)
function tryExecuteCommand(cmd) {
  if (!cmd) return false
  if (!ALLOW_COMMANDS && !botIsOp) {
    try { bot.chat('Cannot run command: not allowed or not op') } catch (e) {}
    return false
  }
  try {
    if (!cmd.startsWith('/')) cmd = '/' + cmd
    console.log('Executing server command:', cmd)
    bot.chat(cmd)
    return true
  } catch (e) {
    try { bot.chat('Failed to send command') } catch (ee) {}
    return false
  }
}

