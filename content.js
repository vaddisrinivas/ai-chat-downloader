// content.js

// ============ Toast Notifications ============

function showToast(message, type = 'info', duration = 3000) {
    // Remove existing toast
    const existingToast = document.getElementById('ai-chat-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.id = 'ai-chat-toast';
    toast.className = `ai-chat-toast ai-chat-toast-${type}`;
    toast.textContent = message;

    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('ai-chat-toast-visible');
    });

    // Auto-hide
    if (duration > 0) {
        setTimeout(() => {
            toast.classList.remove('ai-chat-toast-visible');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    return toast;
}

function updateToast(message, type = 'info') {
    const toast = document.getElementById('ai-chat-toast');
    if (toast) {
        toast.textContent = message;
        toast.className = `ai-chat-toast ai-chat-toast-${type} ai-chat-toast-visible`;
    } else {
        showToast(message, type);
    }
}

function hideToast() {
    const toast = document.getElementById('ai-chat-toast');
    if (toast) {
        toast.classList.remove('ai-chat-toast-visible');
        setTimeout(() => toast.remove(), 300);
    }
}

// ============ Floating Button ============

function createFloatingButton() {
    if (document.getElementById('ai-chat-download-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ai-chat-download-btn';
    btn.className = 'ai-chat-downloader-btn';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
</svg>`;

    btn.addEventListener('click', handleDownload);
    document.body.appendChild(btn);
}

// ============ Download Helpers ============

function downloadFallback(content, filename, contentType = 'text/markdown;charset=utf-8') {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function detectProviderFromUrl(url) {
    if (url.includes('chatgpt.com')) return 'chatgpt';
    if (url.includes('claude.ai')) return 'claude';
    if (url.includes('gemini.google.com')) return 'gemini';
    if (url.includes('perplexity.ai')) return 'perplexity';
    if (url.includes('x.com')) return 'grok';
    if (url.includes('deepseek.com')) return 'deepseek';
    return 'unknown';
}

function normalizeRole(role) {
    const normalized = String(role || '').toLowerCase();
    if (normalized.includes('user') || normalized === 'you') return 'user';
    if (normalized.includes('system')) return 'system';
    if (normalized.includes('tool')) return 'tool';
    return 'assistant';
}

function createNormalizedExport(parsedData) {
    const provider = detectProviderFromUrl(window.location.href);
    const capturedAt = new Date().toISOString();
    const title = parsedData.title || document.title || 'Untitled chat';

    return {
        schema_version: 1,
        source: 'ai-chat-downloader',
        provider,
        title,
        source_url: window.location.href,
        captured_at: capturedAt,
        conversation: {
            title,
            provider,
            source_url: window.location.href,
            captured_at: capturedAt
        },
        messages: (parsedData.messages || []).map((message, index) => ({
            index,
            role: normalizeRole(message.role),
            display_role: message.role || '',
            content: message.content || '',
            created_at: capturedAt,
            time: message.time || '',
            metadata: {
                provider_role: message.role || ''
            }
        }))
    };
}

function downloadLastArtifact() {
    try {
        const downloadButtons = Array.from(document.querySelectorAll('button')).filter(btn =>
            btn.textContent.includes('Download') ||
            btn.getAttribute('aria-label')?.includes('Download')
        );

        if (downloadButtons.length > 0) {
            const lastButton = downloadButtons[downloadButtons.length - 1];
            console.log('Clicking last artifact Download button...');
            lastButton.click();
        }
    } catch (error) {
        console.warn('Failed to auto-download artifact:', error);
    }
}

// ============ Main Download Handler ============

async function handleDownload() {
    const parser = getParser(window.location.href);
    if (!parser) {
        showToast("Parser not found for this site.", 'error');
        return;
    }

    // Visual feedback on the button
    const btn = document.getElementById('ai-chat-download-btn');
    const originalIcon = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<div class="ai-chat-spinner"></div>`;
    }

    try {
        // Load history with timeout
        if (!parser.skipScroll) {
            showToast("Loading chat history...", 'info', 0);
            await loadFullChatHistory(parser);
        }

        updateToast("Parsing messages...", 'info');
        const parsedData = parser.parse();

        if (!parsedData.messages || parsedData.messages.length === 0) {
            showToast("No messages found. Ensure the chat is loaded.", 'error');
            if (btn) {
                btn.innerHTML = originalIcon;
                btn.disabled = false;
            }
            return;
        }

        // Try to download last artifact (for Claude)
        if (window.location.href.includes('claude.ai')) {
            downloadLastArtifact();
        }

        const markdownContent = parser.formatMarkdown(parsedData);
        const normalizedExport = createNormalizedExport(parsedData);
        const jsonContent = JSON.stringify(normalizedExport, null, 2);
        const safeDate = new Date().toISOString().slice(0, 10);
        const safeTitle = (parsedData.title || 'chat').replace(/[\\/:*?"<>|]/g, '_').trim().substring(0, 70) || 'chat';
        const markdownFilename = `${safeTitle}_${safeDate}.md`;
        const jsonFilename = `${safeTitle}_${safeDate}.json`;

        try {
            chrome.runtime.sendMessage({
                action: "DOWNLOAD",
                payload: {
                    filename: markdownFilename,
                    content: markdownContent,
                    contentType: 'text/markdown;charset=utf-8'
                }
            });
            chrome.runtime.sendMessage({
                action: "DOWNLOAD",
                payload: {
                    filename: jsonFilename,
                    content: jsonContent,
                    contentType: 'application/json;charset=utf-8'
                }
            });
            showToast(`Downloaded ${parsedData.messages.length} messages`, 'success');
        } catch (err) {
            console.warn("Extension context invalidated, using fallback download");
            downloadFallback(markdownContent, markdownFilename, 'text/markdown;charset=utf-8');
            downloadFallback(jsonContent, jsonFilename, 'application/json;charset=utf-8');
            showToast(`Downloaded ${parsedData.messages.length} messages`, 'success');
        }
    } catch (error) {
        console.error("Parsing error:", error);
        showToast("Failed to parse chat. See console.", 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalIcon;
            btn.disabled = false;
        }
    }
}

// ============ Scroll History Loading with Timeout ============

const SCROLL_TIMEOUT_MS = 30000; // 30 seconds max

async function loadFullChatHistory(parser) {
    const container = parser.getScrollContainer();
    if (!container) return;

    return new Promise((resolve) => {
        const startTime = Date.now();
        let lastValue = (parser.scrollDirection === 'down' ? container.scrollHeight : (container === window ? window.scrollY : container.scrollTop)) || 0;
        let attemptsOfNoChange = 0;
        const maxNoChange = parser.maxNoChangeAttempts || 5;
        const delayMs = parser.scrollDelayMs || 800;
        const direction = parser.scrollDirection || 'up';

        console.log(`Starting ${direction} scroll for history...`);

        const doScroll = () => {
            if (container === window) {
                if (direction === 'up') window.scrollBy(0, -800);
                else window.scrollBy(0, 800);
            } else {
                if (direction === 'up') {
                    container.scrollTop -= 800;
                } else {
                    container.scrollTop += 800;
                }
            }
        };

        const scroller = setInterval(() => {
            // Check timeout
            if (Date.now() - startTime > SCROLL_TIMEOUT_MS) {
                console.log('Scrolling finished. Reason: Timeout');
                clearInterval(scroller);
                finishScroll();
                return;
            }

            const currentValue = (direction === 'down' ? container.scrollHeight : (container === window ? window.scrollY : container.scrollTop)) || 0;

            const isAtTop = (direction === 'up' && currentValue <= 0);
            const isAtBottom = (direction === 'down' && container !== window && (container.scrollTop + container.clientHeight >= container.scrollHeight - 5));

            if (Math.abs(currentValue - lastValue) > 5) {
                lastValue = currentValue;
                attemptsOfNoChange = 0;
            } else {
                attemptsOfNoChange++;
            }

            const limit = parser.maxScrollAttempts || 30;
            if (isAtTop || isAtBottom || attemptsOfNoChange >= maxNoChange || attemptsOfNoChange >= limit) {
                console.log(`Scrolling finished. Reason: ${isAtTop ? 'At Top' : (isAtBottom ? 'At Bottom' : 'No Change/Limit')}`);
                clearInterval(scroller);
                finishScroll();
            } else {
                doScroll();
            }
        }, delayMs);

        function finishScroll() {
            // Final adjustment
            if (container === window) {
                if (direction === 'up') window.scrollTo(0, 0);
            } else {
                if (direction === 'up') container.scrollTop = 0;
            }
            // Extra wait for lazy items to render
            setTimeout(resolve, 500);
        }
    });
}

// ============ Keyboard Shortcut ============

document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (Mac)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        handleDownload();
    }
});

// ============ SPA Navigation Observer ============

let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        createFloatingButton();
    }
}).observe(document, { subtree: true, childList: true });

// ============ Initial Injection ============

setTimeout(createFloatingButton, 2000);
