const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

/**
 * @description Send an embed
 */
module.exports = {
    // The data property provides the command definition for registering to Discord.
    // Slash command properties
    data: new SlashCommandBuilder()
        .setName('embedcustom')
        .setDescription('Sends an custom embed built into the code of this command - DEV ONLY')
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('The channel to echo to')
        ),

    // The execute method, which will contain the functionality to run from our event handler when the command is used.
    // Command execution
    async execute(interaction, client) {
        try {
            const interactionUser = await interaction.guild.members.fetch(interaction.user.id)
            const nickName = interactionUser.nickname
            const userName = interactionUser.user.username
            const userId = interactionUser.id

            console.log(nickName)
            console.log(userName)
            console.log(userId)

            const error = new EmbedBuilder()
                .setTitle(`🛑🛑🛑 You do not have access to this command 🛑🛑🛑`)
                .setColor(0xA020F0)

            if (userId != 246603355135148032) {
                await interaction.reply({ embeds: [error] });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle("Links")
                .setDescription("1️⃣ **First Day**\n\n🏠 [BrightSpace (Your new home)](https://elearning.nbcc.ca/d2l/home)\n\n🗒️ [Notepad++ (Essential!)](https://notepad-plus-plus.org/downloads/)\n\n<:fast:1143646889674281100> [Emmet (Save time!)](https://flaviocopes.com/emmet/)\n\n⏬ [Azure Developer Tools](https://azureforeducation.microsoft.com/devtools)\n\n\n🧰 **Useful Links/Installs**\n\n📜 [DevDocs - Documentation for everything](https://devdocs.io/)\n\n✍️ [Obsidian - The best note-taking app](https://obsidian.md/download)\n\n🏢 [Microsoft Office Suite - Office 🙄](https://www.office.com/)\n\n<:vs:1143646461695905952> [Visual Studio](https://visualstudio.microsoft.com/downloads/)\n\n<:vscodeoriginal:1067979542850969680> [Visual Studio Code](https://code.visualstudio.com/Download)\n\n<:microsoftsqlserverplain:1067979525213933568> [SSMS](https://learn.microsoft.com/en-us/sql/ssms/download-sql-server-management-studio-ssms?view=sql-server-ver16)\n\n<a:swag:779585536775946250> [OhMyPosh - Beautify your terminal](https://www.hanselman.com/blog/my-ultimate-powershell-prompt-with-oh-my-posh-and-the-windows-terminal)\n\n🛠️ [One Tool for Everything - Tweaks and installs, very useful](https://christitus.com/one-tool-for-everything/)\n\n\n<:vscodeoriginal:1067979542850969680> **VSC Extensions to make life easier**\n\n- [Auto Rename Tag](https://marketplace.visualstudio.com/items?itemName=formulahendry.auto-rename-tag)\n- [Autoprefixer](https://marketplace.visualstudio.com/items?itemName=mrmlnc.vscode-autoprefixer)\n- [Better Comments](https://marketplace.visualstudio.com/items?itemName=aaron-bond.better-comments)\n- [C# Extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp)\n- [CSS Peek](https://marketplace.visualstudio.com/items?itemName=pranaygp.vscode-css-peek)\n- [Discord Presence](https://marketplace.visualstudio.com/items?itemName=icrawl.discord-vscode)\n- [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)\n- [Live Share](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare/)\n- [Material Icon Theme](https://marketplace.visualstudio.com/items?itemName=PKief.material-icon-theme)\n- [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)\n\n\n🆓 **NBCC Free Stuff**\n\n🎶 [Spotify](https://www.spotify.com/ca-en/student/) - 3 months free / 50% off while a student\nIf you don't already have an account, use this link to sign up for a new Spotify account. \nUse NBCC Fredericton as your school, and provide your student email when asked. \nIf you already have an account, use the same link but sign in to your current account. There should be an option to upgrade your current plan, and then you can follow the same steps as a new account.\n\n🚢 [Amazon Prime Student](https://www.amazon.com/Amazon-Student/b?ie=UTF8&node=668781011) - 6 months free / 50% off while a student\nUse this link with a pre-existing account, enter the required information and complete verification through email.\n\n✅ [Grammarly](https://grammarly.com/) - Free while a student\nSign up with your @mynbcc.ca email.\nGrammarly EDU Activation: [Grammarly EDU Activation](https://www.grammarly.com/enterprise/apply-access-code) (Go to this link while signed in and enter the code below)\nGrammarly Code: ETnkpmHpdBEUgIuq\n\n🤩 [GitHub Pro](https://education.github.com/pack/offers) - Free while a student\nLink with school email.\nYou have access to a lot of great bonuses and extra packages.\n\n🧰 [JetBrains Toolbox](https://www.jetbrains.com/shop/eform/students) - Free while a student\nLink with GitHub Pro account.")
                .setColor("#580476")
                .setFooter({
                    text: "NBCC WMAD & GEX",
                    iconURL: "https://scontent-lga3-1.xx.fbcdn.net/v/t39.30808-6/350353523_990049728673372_9163496265846603301_n.jpg?_nc_cat=110&ccb=1-7&_nc_sid=09cbfe&_nc_ohc=y8jz95jr_7oAX_1hEYn&_nc_ht=scontent-lga3-1.xx&oh=00_AfB2a4rbCIN6m8yUnSA9RrgLq6TrP59-hW2bMmnAPW_0dQ&oe=64E9E9DA",
                })
                .setTimestamp();

            const embed2 = new EmbedBuilder()
                .setTitle("FAQ")
                .setDescription("❓ I forgot what the comment for Delon's assignments was supposed to be!\n\n<a:Verified:779136182407004161> \"This assignment represents my own work and is in accordance with the College Academic Policy\"\n\n❓ How do I use the class printer?\n\n<a:Verified:779136182407004161> \n1. Enter this into your file explorer: \\nbcc-srv-v-ps01.students.nbcc.loc\n2. When/if you are prompted (I was never prompted but you probably will) you need to use your student email/password for example:         JSMITH04@mynbcc.ca\n3. You will be presented with all the school printers in NB:\n4. Choose the proper printer & click 'connect'!\n\n❓ Want to skip typing text from images on the test spec sheet? Want to copy from a recorded lecture without a live-share?\n\n<a:Verified:779136182407004161>\nTo copy text from any image:\n        - Win+Shift+S and select the area\n        - Open MS OneNote\n        - Ctrl+V\n        - Right click on the image and select Copy text from the picture\n\n❓  How to create a repo, a gitignore, and push to a brand new private remote/origin all through the terminal (No https://github.com/ visit required!)\n\n⭐ You can also add collaborators to private repos through github CLI, see the bonus section at the end of this message\n\n✅  Prerequisites ✅\n\n🔲 Make sure you have Github CLI installed & set up. Go to https://cli.github.com/ to download it and follow the instructions.\n\n🔲 For gitignore file generator, make sure you have the following NPM module installed on your computer: \nhttps://github.com/generate/generate-gitignore\nYou install it with npm install --global generate generate-gitignore\n\n🎉 Now, you can type in your command line gen gitignore:node to create a node gitignore file in the current folder.\n\n🔧 Steps 🔧 \n\nNow, the steps to set up a repo properly is as follows: \n\n1️⃣  Navigate to the root of your project where you want your repo to be initialized. \n2️⃣  Open terminal there (Shift-Right click, Open Commandline or Terminal)\n3️⃣  Type the following:\n\n```git init\n\ngen gitignore:visualstudio (or :node if you need a node project)\n\ngit add .\n\ngit commit -m \"Initial Commit\"\n\ngh repo create NameOfRepo --private --source . --push```\n\nThis will create a repo, add a gitignore, and create an online github remote, and automatically push your commits to it.\n\n🗒️ Note 🗒️ \n\nAliases are shortcut commands you can set up with gh to avoid writing long commands.\n\nI recommend you create an alias for the repo create command, as it can be long to type out. You can do it like this:\n\n```gh alias set createPrivate 'repo create $1 --private --push -s $2'```\n\nThis will now allow you to type:\n\n```gh createPrivate NameOfYourRepo .```\nRemember, the . means current directory\n\n⭐ Bonus ⭐\n\nIf you want to be able to add collaborators to your private project (like for assignments and exercises), you can add another alias as follows:\n\n```gh alias set adduser 'api -XPUT repos/:owner/:repo/collaborators/$1 -f permission=push```\n\nFor example, this will allow you to add the user  chrisecusack with the following command:\n\n```gh adduser chrisecusack```\n\nCorrect execution of this command will spit out a lot of json, this means everything went smoothly.")
                .setColor("#580476")
                .setFooter({
                    text: "NBCC WMAD & GEX",
                    iconURL: "https://scontent-lga3-1.xx.fbcdn.net/v/t39.30808-6/350353523_990049728673372_9163496265846603301_n.jpg?_nc_cat=110&ccb=1-7&_nc_sid=09cbfe&_nc_ohc=y8jz95jr_7oAX_1hEYn&_nc_ht=scontent-lga3-1.xx&oh=00_AfB2a4rbCIN6m8yUnSA9RrgLq6TrP59-hW2bMmnAPW_0dQ&oe=64E9E9DA",
                })
                .setTimestamp();

            await interaction.channel.send({ embeds: [embed] });
            await interaction.channel.send({ embeds: [embed2] });

        } catch (e) {
            console.log(e);
        }
    },
};
