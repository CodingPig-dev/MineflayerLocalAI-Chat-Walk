# MineflayerLocalAI-Chat-Walk

MineflayerLocalAI-Chat&Walk integrates Mineflayer with local models in GPT4All to create autonomous Minecraft bots.  
They can chat, walk, mine, and place blocks, simulating intelligent player-like behavior without cloud APIs, designed for experimentation and extensible AI-driven gameplay. Completely free to use.

## License
This project includes official Mineflayer code in the `lib` folder.  
Mineflayer is released under the MIT License, which allows reuse and redistribution provided that the original copyright notice and license text are retained.  
The included Mineflayer code remains under its original license, while additional code in this project is also published under MIT.

## How to do
1. Download and install [GPT4All](https://gpt4all.io/index.html?ref=localhost).  
2. Inside GPT4All, install the model **Llama 3 8B Instruct**.  
3. Open the settings, scroll down, and enable the checkbox **Enable Local API Server**. Keep the app running while using the AI.  
4. Install **Node.js** from the official website.  
5. Set the URL and port of your Minecraft server in line 43 & 44 of `index.js`.  
6. Navigate to your project folder in the terminal.  
7. Run the project with:
   ```bash
   node index.js
   
   Info:
   To change the model, download it in GPT4All and set the model name in line 21 of index.js.
