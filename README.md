# AI Chat Downloader

<p align="center">
  <img src="icons/icon128.png" alt="AI Chat Downloader" width="128" height="128">
</p>

<p align="center">
  <strong>Export AI conversations and search them through a local MCP context engine</strong>
</p>

<p align="center">
  <a href="#supported-platforms">Platforms</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#features">Features</a> •
  <a href="#contributing">Contributing</a>
</p>

---

Chrome extension for exporting chat conversations from AI platforms to well-formatted Markdown and normalized JSON files. This fork also includes a local-first MCP context engine for importing browser exports, indexing local assistant histories, searching, daily syncing, and building context packs.

## Supported Platforms

| Platform | URL | Status | Features |
|----------|-----|--------|----------|
| ChatGPT | chatgpt.com | ✅ Full | Text, code blocks, images |
| Claude | claude.ai | ✅ Full | Text, code, artifacts, canvas |
| Gemini | gemini.google.com | ✅ Full | Text, code blocks |
| Perplexity | perplexity.ai | ✅ Full | Text, code, source links |
| Grok | x.com | ✅ Working | Text, basic formatting |
| DeepSeek | chat.deepseek.com | ✅ Working | Text, code blocks |

### Planned Platforms
- Qwen (chat.qwen.ai)
- Kimi (kimi.com)
- Zai (chat.z.ai)
- Mistral (chat.mistral.ai)
- Manus (manus.im)

## Installation

### Chrome Web Store
*(Coming soon)*

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/creatyvin/ai-chat-downloader.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top right)

4. Click **Load unpacked** and select the cloned folder

5. The extension icon will appear in your toolbar

## Usage

### Method 1: Floating Button
1. Open any supported AI chat
2. Click the floating download button (bottom-right corner)
3. Wait for auto-scroll to load full history
4. Chat downloads as Markdown

### Method 2: Popup
1. Click the extension icon in toolbar
2. Click "Download Chat"

### Method 3: Keyboard Shortcut
- **Windows/Linux**: `Ctrl + Shift + D`
- **Mac**: `Cmd + Shift + D`

### Settings
Click the extension icon → **Settings** to configure:
- **Download folder**: Subfolder in Downloads (default: `AI_Chats`)

## Features

- **One-Click Export** — Single click to download entire conversation
- **Normalized JSON Export** — Saves machine-readable conversation data next to Markdown
- **Local MCP Context Engine** — Search imported chats and build agent-ready context packs
- **Local History Indexing** — Index Codex, Claude Code, Gemini/Antigravity, VS Code Chat, and GitHub Copilot histories by reference
- **Raw Log References** — Keep bulky tool outputs in original files and store `source_file`/`line` pointers instead of duplicating raw logs
- **Auto-Scroll** — Automatically loads full chat history
- **Clean Markdown** — Proper formatting with headers, code blocks, lists
- **Code Preservation** — Maintains syntax highlighting language tags
- **Artifact Support** — Extracts Claude artifacts and canvas content
- **Source Links** — Preserves Perplexity source citations
- **Image References** — Includes image URLs in output
- **Deduplication** — Prevents duplicate messages in export
- **Keyboard Shortcut** — Quick access with Ctrl+Shift+D
- **Custom Folder** — Configure download location
- **Toast Notifications** — Visual feedback during export
- **Privacy First** — 100% local, no data sent anywhere

## Output Format

Files are saved as:
```
Downloads/AI_Chats/ChatTitle_YYYY-MM-DD.md
Downloads/AI_Chats/ChatTitle_YYYY-MM-DD.json
```

Example output:
```markdown
# How to use Python decorators

**Date:** 1/18/2026, 10:30:00 AM

---

### User

Can you explain Python decorators?

---

### ChatGPT

Decorators in Python are a powerful feature...

```python
def my_decorator(func):
    def wrapper():
        print("Before function")
        func()
        print("After function")
    return wrapper

@my_decorator
def say_hello():
    print("Hello!")
```

---
```

## Architecture

```
ai-chat-downloader/
├── manifest.json       # Extension manifest (V3)
├── background.js       # Service worker for downloads
├── content.js          # Main logic (button, scroll, toast)
├── popup.html/js       # Extension popup UI
├── options.html/js     # Settings page
├── styles.css          # UI styles
├── mcp/                # Local vault CLI + MCP server
├── icons/              # Extension icons
└── parsers/
    ├── base.js         # Base class + factory + shared methods
    ├── chatgpt.js      # ChatGPT parser
    ├── claude.js       # Claude parser (with artifacts)
    ├── gemini.js       # Gemini parser
    ├── perplexity.js   # Perplexity parser (with sources)
    └── others.js       # Grok + DeepSeek parsers
```

## MCP Context Engine

This fork can act as a single-pane memory layer for exported AI chats.

```bash
npm run sync
npm run sync:local
npm run mcp
node mcp/cli.js search "pricing bug"
node mcp/cli.js tools "npm run test" --tool exec_command --limit 10
node mcp/cli.js tool-stats --provider codex
node mcp/cli.js context "pricing bug" --max-chars 8000
node mcp/cli.js raw ~/.codex/sessions/2026/.../rollout.jsonl --line 1234
npm run export:personal-ai-memory -- --dry-run
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/exports/personal-ai-memory.json
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/personal-ai-memory-imports --chunk-size 25000 --max-content-chars 4000
npm run sync:personal-ai-memory
node mcp/cli.js sync --all --watch-24h
scripts/install-daily-sync.sh
```

Default vault:

```bash
~/.ai-chat-vault
```

See [docs/MCP_CONTEXT_ENGINE.md](docs/MCP_CONTEXT_ENGINE.md).

## Personal AI Memory Export

To import this vault into the Personal AI Memory Layer extension, export a backup-compatible JSON file:

```bash
npm run sync
npm run export:personal-ai-memory -- --dry-run
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/exports/personal-ai-memory.json
npm run export:personal-ai-memory -- --out ~/.ai-chat-vault/personal-ai-memory-imports --chunk-size 25000 --max-content-chars 4000
```

Then open the Personal AI Memory extension and import the generated JSON as an AI Memory backup.

The export includes Codex, Claude Code, Gemini, GitHub Copilot, VS Code Chat, browser-exported chats, and tool-call rows. Tool outputs that were indexed by reference keep `rawRef` metadata pointing back to the original local file instead of copying every giant output into the export.

Do not commit or push generated vault exports. They can contain private chats, file paths, code, credentials, and tool output snippets.

For hourly refreshes of Personal AI Memory import chunks:

```bash
scripts/install-personal-ai-memory-sync.sh
```

## Contributing

Contributions are welcome!

### Adding a New Platform

1. Create `parsers/newplatform.js` extending `ChatParser`:
   ```javascript
   class NewPlatformParser extends ChatParser {
       getScrollContainer() {
           return document.querySelector('.scroll-container');
       }

       parse() {
           const messages = [];
           // Your parsing logic here
           return {
               title: document.title,
               date: new Date().toLocaleString(),
               messages
           };
       }
   }
   window.NewPlatformParser = NewPlatformParser;
   ```

2. Register in `parsers/base.js`:
   ```javascript
   if (url.includes('newplatform.com')) {
       return new window.NewPlatformParser();
   }
   ```

3. Add to `manifest.json`:
   - `host_permissions`: `"*://newplatform.com/*"`
   - `content_scripts.matches`: `"*://newplatform.com/*"`
   - `content_scripts.js`: `"parsers/newplatform.js"`

4. Test and submit a PR!

### Base Class Methods

Parsers inherit these utility methods from `ChatParser`:
- `extractTextContent(element)` — Clean text extraction
- `extractImages(element)` — Find and format images as Markdown
- `extractCodeBlocks(element)` — Extract code with language detection
- `extractLinks(element)` — Extract hyperlinks
- `formatCodeBlocksMarkdown(blocks)` — Format code blocks
- `formatMarkdown(data)` — Convert parsed data to Markdown

## Privacy

This extension:
- Does **NOT** collect any personal data
- Does **NOT** send data to external servers
- Does **NOT** require an account
- Works **100% locally** in your browser

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for details.

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Made with ❤️ for AI enthusiasts who value their conversations
</p>
