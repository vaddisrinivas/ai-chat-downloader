// Service worker for handling downloads

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "DOWNLOAD") {
        const { filename, content, contentType = "text/markdown" } = request.payload;

        chrome.storage.sync.get(["downloadFolder"], (result) => {
            let folder = result.downloadFolder || "AI_Chats";
            folder = folder.replace(/[<>:"/\\|?*]/g, "").trim();
            if (!folder) folder = "AI_Chats";

            const fullPath = `${folder}/${filename}`;
            const blob = new Blob([content], { type: contentType });
            const reader = new FileReader();

            reader.onload = function () {
                const url = this.result;

                chrome.downloads.download({
                    url: url,
                    filename: fullPath,
                    saveAs: false,
                    conflictAction: "uniquify"
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        console.error("Download failed with folder:", chrome.runtime.lastError);

                        // Fallback: try without folder
                        chrome.downloads.download({
                            url: url,
                            filename: filename,
                            saveAs: false,
                            conflictAction: "uniquify"
                        }, (fallbackId) => {
                            if (chrome.runtime.lastError) {
                                console.error("Fallback download also failed:", chrome.runtime.lastError);
                                sendResponse({ success: false, error: chrome.runtime.lastError.message });
                            } else {
                                sendResponse({ success: true, downloadId: fallbackId, usedFallback: true });
                            }
                        });
                    } else {
                        sendResponse({ success: true, downloadId });
                    }
                });
            };

            reader.onerror = function () {
                console.error("FileReader error");
                sendResponse({ success: false, error: "FileReader error" });
            };

            reader.readAsDataURL(blob);
        });

        // Return true to indicate async response
        return true;
    }
});
