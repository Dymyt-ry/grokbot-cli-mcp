# grokbot demo. Record with: vhs docs/demo.tape (needs a Cursor login and the Grok Bot app account)
Output docs/demo.gif

Set Shell bash
Set Width 1400
Set Height 820
Set FontSize 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set WindowBarSize 40
Set Padding 26
Set Margin 28
Set MarginFill "#181825"
Set BorderRadius 14
Set TypingSpeed 35ms

Hide
Type "rm -rf /tmp/demo && mkdir -p /tmp/demo && cd /tmp/demo && printf 'def add(a, b):\n    return a - b\n' > calc.py"
Enter
Type `export PS1='\[\e[1;35m\]❯\[\e[0m\] '; grokbot(){ if [ $# -eq 0 ]; then command grokbot --no-skills; else command grokbot "$@"; fi; }; clear`
Enter
Sleep 1s
Show

Type "# ⚡ grokbot: Grok in your terminal, your Grok Bot app bots, and Claude Code"
Enter
Sleep 1s
Type "grokbot --version"
Enter
Sleep 2s

Type "# 🤖 your bots from the official Grok Bot app"
Enter
Type "grokbot bot list"
Enter
Wait@30s /❯\s*$/
Sleep 2s

Type "# 💬 message one (it shows up in the app too)"
Enter
Type 'grokbot bot send "In one sentence: why should a dev try grokbot?"'
Enter
Sleep 2s
Hide
Wait@180s /❯\s*$/
Show
Sleep 5s

Type "clear"
Enter
Type "# 🧠 a full coding agent on Grok 4.7: fix a real bug"
Enter
Type "cat calc.py"
Enter
Sleep 2s
Type "grokbot"
Enter
Wait+Screen@30s /grok-4\.7/
Sleep 2s
Type "fix the bug in calc.py"
Sleep 500ms
Enter
Sleep 4s
Hide
Wait+Screen@240s /⚙ edit/
Sleep 25s
Show
Sleep 6s
Type "/quit"
Enter
Wait@20s /❯\s*$/
Type "cat calc.py"
Enter
Sleep 3s

Type "# 🔌 and an MCP server for Claude Code (grok_ask, grok_agent, bot_send, ...)"
Enter
Type "claude mcp list 2>/dev/null | grep grokbot"
Enter
Hide
Wait@90s /❯\s*$/
Show
Sleep 4s

Type "# ⭐ github.com/cufelix/grokbot-cli-mcp"
Enter
Sleep 4s
