import React from 'react';


// Reads a locally-picked image file (photo library or files) and hands back a compact data URL.
// Everything in this app already persists through the same project JSON blob (backed by
// IndexedDB), so a data URL slots in anywhere a pasted image URL currently works — character
// portraits, location galleries, map backgrounds — with no other rendering code to change.
// Large photos are downscaled before encoding, and if still too big, progressively re-compressed —
// a handful of these accumulating across a project's locations, characters, and maps is exactly
// what exhausts a browser's storage quota and breaks autosave, so this errs on the side of a
// smaller file over a failed save discovered later.
export const MAX_IMAGE_DATA_URL_BYTES = 1200000;

 // ~1.2MB per image, generous but bounded
export function readLocalImageFile(file, maxDim = 1600, quality = 0.86) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) {
            reject(new Error('Please choose an image file.'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Couldn't read that file."));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("Couldn't read that image."));
            img.onload = () => {
                // Keep transparency-friendly formats as PNG; re-encode everything else (typically
                // camera photos) as JPEG so the stored data URL stays reasonably small. Note PNG
                // ignores the quality argument entirely, so a still-too-large transparent image can
                // only shrink further by dimension on the later attempts, not recompression.
                const keepPng = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
                const attempts = [
                    { dim: maxDim, q: quality },
                    { dim: Math.round(maxDim * 0.75), q: Math.max(0.55, quality - 0.2) },
                    { dim: Math.round(maxDim * 0.55), q: 0.5 },
                    { dim: Math.round(maxDim * 0.4), q: 0.4 },
                ];
                let smallest = null;
                for (const attempt of attempts) {
                    let { width, height } = img;
                    if (width > attempt.dim || height > attempt.dim) {
                        const scale = attempt.dim / Math.max(width, height);
                        width = Math.max(1, Math.round(width * scale));
                        height = Math.max(1, Math.round(height * scale));
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    const dataUrl = canvas.toDataURL(keepPng ? 'image/png' : 'image/jpeg', attempt.q);
                    if (!smallest || dataUrl.length < smallest.length)
                        smallest = dataUrl;
                    if (dataUrl.length <= MAX_IMAGE_DATA_URL_BYTES) {
                        resolve(dataUrl);
                        return;
                    }
                }
                // Every attempt was still too large (typically a very large, highly detailed PNG) —
                // fail clearly rather than silently saving something that risks breaking autosave.
                reject(new Error("That image is too large to store even after compressing it \u2014 try a smaller photo, or convert it to JPEG first."));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}


// Guards the "paste an image URL" fallback against someone pasting a raw base64 data URL that's
// too large — the upload path above always compresses, but a pasted data URL bypasses that
// entirely and could otherwise land directly in the project at full size.
export function validatePastedImageUrl(value) {
    if (value.startsWith('data:') && value.length > MAX_IMAGE_DATA_URL_BYTES)
        return "That image is too large to store \u2014 try uploading it as a photo instead (which compresses it automatically) rather than pasting it directly.";
    return null;
}


// ---------- Whole-project image optimization (Settings \u2192 Optimize Images) ----------
// New uploads are compressed going in (see readLocalImageFile above), but that does nothing for
// images already sitting in a project from before that existed, or from many large uploads over
// time — those can still add up to more than a browser's storage quota and make the live autosave
// itself start failing. This walks the *entire* project generically (not a fixed list of "map
// image", "portrait", "banner" fields) looking for any embedded image over a size threshold and
// re-compresses it in place, so it also covers whatever new image-bearing fields get added later
// without needing this function updated to match.
export const REOPTIMIZE_THRESHOLD_BYTES = 150000;


export function recompressDataUrl(dataUrl, maxDim = 1400, quality = 0.75) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onerror = () => resolve(dataUrl); // leave it exactly as-is if it can't even be read back
        img.onload = () => {
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
                const scale = maxDim / Math.max(width, height);
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            const keepPng = /^data:image\/(png|gif|webp)/.test(dataUrl);
            const out = canvas.toDataURL(keepPng ? 'image/png' : 'image/jpeg', quality);
            resolve(out.length < dataUrl.length ? out : dataUrl); // never trade a smaller image for a bigger one
        };
        img.src = dataUrl;
    });
}


export async function optimizeProjectImages(project) {
    const clone = structuredClone(project);
    let freedBytes = 0, recompressedCount = 0;
    async function walk(node) {
        if (!node || typeof node !== 'object')
            return;
        const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
        for (const k of keys) {
            const v = node[k];
            if (typeof v === 'string' && v.startsWith('data:image') && v.length > REOPTIMIZE_THRESHOLD_BYTES) {
                const before = v.length;
                const after = await recompressDataUrl(v);
                node[k] = after;
                if (after.length < before) {
                    freedBytes += before - after.length;
                    recompressedCount++;
                }
            }
            else if (v && typeof v === 'object') {
                await walk(v);
            }
        }
    }
    await walk(clone);
    return { project: clone, freedBytes, recompressedCount };
}
