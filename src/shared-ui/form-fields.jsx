import React, { useState, useRef } from 'react';
import { storage } from '../lib/storage.js';
import { optimizeProjectImages, readLocalImageFile } from './image-utils.jsx';
import { deleteUploadedImage, isUploadedMediaUrl, uploadImageDataUrl } from '../lib/mediaStorage.js';
import { SectionLabel } from './ui-cards.jsx';
import { formatBytes } from '../shared-utils/format-bytes.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { projectKey } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { BookCover, COVER_ACCENTS, COVER_ACCENT_ORDER, COVER_MOTIFS, COVER_STYLES, COVER_STYLE_ORDER, COVER_THEMES, COVER_THEME_ORDER } from '../worldbuilding/book-cover.jsx';
import { reclaimBackupSpace } from '../writing/project-schema-and-backups.jsx';


// ---------- Image Optimization (Settings \u2192 Optimize Images) ----------
// Runs optimizeProjectImages (defined above) against the live project and hands the shrunk result
// back via onOptimized. Exists for projects that accumulated oversized images before upload
// compression existed, or from many large uploads over time — a one-time cleanup rather than
// something that needs to run on every save.
export function ImageOptimizePanel({ project, projectId, onOptimized }) {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const run = async () => {
        setBusy(true);
        setResult(null);
        try {
            const { project: optimized, freedBytes, recompressedCount } = await optimizeProjectImages(project);
            // Old backups made before backups stripped heavy media still hold full-size images —
            // clean those up too, since they count against the same shared quota.
            const backupFreed = await reclaimBackupSpace(projectKey(projectId));
            onOptimized(optimized);
            // Try saving right away rather than waiting for the regular debounce, so the result
            // below can say plainly whether this actually fixed the problem or not.
            let saveOk = true;
            try {
                await storage.set(projectKey(projectId), JSON.stringify(optimized));
            }
            catch (e) {
                saveOk = false;
            }
            setResult({ freedBytes: freedBytes + backupFreed, recompressedCount, saveOk });
        }
        finally {
            setBusy(false);
        }
    };
    return React.createElement("div", null,
        React.createElement("button", { disabled: busy, onClick: run, style: {
                display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: '#C89B3C', color: '#17171B', border: 'none',
                borderRadius: RADIUS_SCALE[6], padding: '8px 14px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            } }, busy ? 'Optimizing\u2026' : 'Optimize Images Now'),
        result && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: (result.recompressedCount > 0 || result.freedBytes > 0) ? (result.saveOk ? '#7FA98A' : '#D98A8A') : '#5C5C64', marginTop: 8 } }, (result.recompressedCount > 0 || result.freedBytes > 0)
            ? `Recompressed ${result.recompressedCount} image${result.recompressedCount === 1 ? '' : 's'} and cleaned old backups, freeing about ${formatBytes(result.freedBytes)}. ${result.saveOk ? 'Your project saves normally again.' : "Still not enough on its own \u2014 try again, or use \u201CFree up storage\u201D from the All Projects screen if you have other projects on this device."}`
            : "No images here needed optimizing. If saving still fails, storage may be full from other projects on this device \u2014 try \u201CFree up storage\u201D from the All Projects screen."));
}


export function inputStyle(fontSize, weight) {
    return {
        background: 'transparent', border: 'none', color: '#EFE7D2',
        fontSize, fontWeight: weight, width: '100%', fontFamily: "'Inter', sans-serif",
    };
}


export function TagInput({ tags, onChange, label, placeholder }) {
    const [draft, setDraft] = useState('');
    const commit = () => {
        const v = draft.trim();
        if (v && !tags.some((t) => t.toLowerCase() === v.toLowerCase()))
            onChange([...tags, v]);
        setDraft('');
    };
    return (React.createElement("div", null,
        React.createElement(SectionLabel, null, label || "Tags"),
        React.createElement("div", { style: {
                display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[6], alignItems: 'center', background: '#1D1D22',
                border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: '8px 10px', minHeight: 20,
            } },
            tags.map((t, i) => (React.createElement("span", { key: i, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[5], fontSize: TYPE_SCALE[12], color: '#D9D2BE',
                    background: '#232328', borderRadius: RADIUS_SCALE[12], padding: '3px 5px 3px 10px',
                } },
                t,
                React.createElement("button", { onClick: () => onChange(tags.filter((_, ti) => ti !== i)), style: {
                        background: 'none', border: 'none', color: '#7A7A82', cursor: 'pointer', fontSize: TYPE_SCALE[13], lineHeight: 1, padding: '0 2px',
                    } }, "\u00D7")))),
            React.createElement("input", { value: draft, placeholder: tags.length === 0 ? (placeholder || 'Add a tag and press Enter…') : 'Add another…', onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        commit();
                    }
                    else if (e.key === 'Backspace' && !draft && tags.length > 0) {
                        onChange(tags.slice(0, -1));
                    }
                }, onBlur: commit, style: { ...inputStyle(12.5, 500), flex: 1, minWidth: 100, width: 'auto' } }))));
}


export function Field({ label, value, onChange, textarea, large, placeholder, disabled, maxLength }) {
    return (React.createElement("div", null,
        React.createElement(SectionLabel, null, label),
        textarea ? (React.createElement("textarea", { placeholder: placeholder, value: value || '', disabled: disabled, maxLength: maxLength, onChange: (e) => onChange(e.target.value), style: {
                width: '100%', minHeight: 90, background: disabled ? '#18181C' : '#1D1D22', border: '1px solid #2A2A30',
                borderRadius: RADIUS_SCALE[8], padding: 12, color: disabled ? '#7A7A82' : '#EFE7D2', fontSize: TYPE_SCALE[14.5], lineHeight: 1.6, resize: 'vertical',
                cursor: disabled ? 'not-allowed' : 'text',
            } })) : (React.createElement("input", { placeholder: placeholder, value: value || '', disabled: disabled, maxLength: maxLength, onChange: (e) => onChange(e.target.value), style: {
                width: '100%', background: disabled ? '#18181C' : '#1D1D22', border: '1px solid #2A2A30',
                borderRadius: RADIUS_SCALE[8], padding: '10px 12px', color: disabled ? '#7A7A82' : '#EFE7D2',
                fontSize: large ? 20 : 14.5, fontFamily: large ? "'Fraunces', Georgia, serif" : "'Inter', sans-serif",
                cursor: disabled ? 'not-allowed' : 'text',
            } }))));
}


// The cover style/accent/motif picker shown in a project's Settings tab, with a live large
// BookCover preview so a choice is judged against the actual title/subtitle/series/author rather
// than a swatch in isolation.
export function CoverPicker({ cover, onChange, title, subtitle, seriesName, author }) {
    const current = cover || { style: 'leather', accent: 'gold', motif: 'compass', customImageUrl: '' };
    const hasCustomImage = !!current.customImageUrl;
    const fileInputRef = useRef(null);
    const [uploadError, setUploadError] = useState('');
    const activeTheme = COVER_THEME_ORDER.find((key) => {
        const t = COVER_THEMES[key];
        return t.style === current.style && t.accent === current.accent && t.motif === current.motif;
    }) || null;
    const handleFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setUploadError('');
        try {
            // Covers are portrait and shown small, so 1000px on the long edge is plenty — keeps the
            // stored data URL modest alongside everything else in the project's storage quota.
            const dataUrl = await readLocalImageFile(file, 1000, 0.85);
            // A cover stays local-only (part of the project's own JSON in kv_store) unless the
            // book is published to a guild, at which point library-guild.js's
            // publishBookToGuildRemote copies this exact `cover` object into
            // guild_published_books.cover — a jsonb column every guild member's device reads.
            // Uploading here rather than at publish time means that table only ever sees a
            // short URL, never the raw image, regardless of when publishing happens relative to
            // the upload. Falls back to the data URL when signed out/offline, same as every
            // other image upload in this app — the cover picker still works fully offline.
            const previousCoverUrl = current.customImageUrl;
            const uploadedUrl = await uploadImageDataUrl(dataUrl, 'book-covers');
            onChange({ customImageUrl: uploadedUrl || dataUrl });
            if (uploadedUrl && isUploadedMediaUrl(previousCoverUrl)) {
                deleteUploadedImage(previousCoverUrl);
            }
        }
        catch (err) {
            setUploadError(err.message || "Couldn't use that image.");
        }
    };
    const swatchRow = (label, options, activeKey, onPick, renderOption) => React.createElement("div", { style: { marginBottom: 14 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' } }, label),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } }, options.map((key) => renderOption(key, key === activeKey, () => onPick(key)))));
    const themeButtons = swatchRow("Genre theme", COVER_THEME_ORDER, activeTheme, (key) => onChange(Object.assign({ customImageUrl: '' }, { style: COVER_THEMES[key].style, accent: COVER_THEMES[key].accent, motif: COVER_THEMES[key].motif })), (key, active, pick) => React.createElement("button", {
        key: key, onClick: pick, style: {
            background: active ? '#2A2A30' : 'none', border: `1px solid ${active ? '#C89B3C' : '#2A2A30'}`,
            color: active ? '#EFE7D2' : '#A6A6AD', borderRadius: RADIUS_SCALE[8], padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
        }
    }, COVER_THEMES[key].label));
    const disabledStyle = hasCustomImage ? { opacity: 0.4, pointerEvents: 'none' } : null;
    const styleButtons = swatchRow("Material", COVER_STYLE_ORDER, current.style, (key) => onChange({ style: key }), (key, active, pick) => React.createElement("button", {
        key: key, onClick: pick, style: {
            background: active ? '#2A2A30' : 'none', border: `1px solid ${active ? '#C89B3C' : '#2A2A30'}`,
            color: active ? '#EFE7D2' : '#A6A6AD', borderRadius: RADIUS_SCALE[8], padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
        }
    }, COVER_STYLES[key](COVER_ACCENTS.gold).label));
    const accentButtons = swatchRow("Accent", COVER_ACCENT_ORDER, current.accent, (key) => onChange({ accent: key }), (key, active, pick) => React.createElement("button", {
        key: key, onClick: pick, title: key, style: {
            width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', padding: 0,
            background: COVER_ACCENTS[key].mid, border: active ? '2px solid #EFE7D2' : '2px solid transparent',
            boxShadow: active ? '0 0 0 2px #17171B, 0 0 0 3px #C89B3C' : 'none',
        }
    }));
    const motifButtons = swatchRow("Ornament", Object.keys(COVER_MOTIFS), current.motif, (key) => onChange({ motif: key }), (key, active, pick) => React.createElement("button", {
        key: key, onClick: pick, style: {
            background: active ? '#2A2A30' : 'none', border: `1px solid ${active ? '#C89B3C' : '#2A2A30'}`,
            color: active ? '#EFE7D2' : '#A6A6AD', borderRadius: RADIUS_SCALE[8], padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer', textTransform: 'capitalize',
        }
    }, key));
    const uploadSection = React.createElement("div", { style: { marginBottom: 4 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' } }, "Custom cover"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', alignItems: 'center' } },
            React.createElement("button", { onClick: () => fileInputRef.current && fileInputRef.current.click(), style: {
                    background: '#232328', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[8],
                    padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                } }, hasCustomImage ? "Replace image" : "Upload image"),
            hasCustomImage && React.createElement("button", { onClick: () => {
                    if (isUploadedMediaUrl(current.customImageUrl)) {
                        deleteUploadedImage(current.customImageUrl);
                    }
                    onChange({ customImageUrl: '' });
                }, style: {
                    background: 'none', border: '1px solid #5C2A2A', color: '#D98A8A', borderRadius: RADIUS_SCALE[8],
                    padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                } }, "Remove"),
            React.createElement("input", { ref: fileInputRef, type: "file", accept: "image/*", onChange: handleFile, style: { display: 'none' } })),
        uploadError && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D98A8A', marginTop: 8 } }, uploadError),
        hasCustomImage && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 8, lineHeight: 1.5 } }, "Your image replaces the generated artwork entirely \u2014 upload one with its own title lettering already on it. The material, accent, and ornament controls below are disabled while a custom cover is set."));
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Book Cover"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[22], flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 4 } },
            React.createElement(BookCover, { title, subtitle, seriesName, author, cover: current, size: 'lg' }),
            React.createElement("div", { style: { flex: 1, minWidth: 220 } },
                uploadSection,
                React.createElement("div", { style: disabledStyle }, themeButtons, styleButtons, accentButtons, motifButtons))));
}


// ---------- Mention dropdown ----------
export function mentionTypeMeta(type) {
    switch (type) {
        case 'character': return { label: 'Cast', color: '#C89B3C' };
        case 'location': return { label: 'Place', color: '#5B8FC9' };
        case 'world': return { label: 'World', color: '#5BA893' };
        case 'glossary': return { label: 'Term', color: '#B07CC6' };
        case 'timeline': return { label: 'Event', color: '#D9825B' };
        default: return { label: '', color: '#7A7A82' };
    }
}


export function MentionDropdown({ items, activeIndex, onSelect, top, left }) {
    return (React.createElement("div", { className: "ink-dropdown-in", style: {
            position: 'fixed', top, left, background: '#1D1D22', border: '1px solid #2A2A30',
            borderRadius: RADIUS_SCALE[8], minWidth: 210, maxHeight: 220, overflowY: 'auto',
            boxShadow: '0 12px 28px rgba(0,0,0,0.45)', zIndex: 1000,
        } }, items.length === 0 ? (React.createElement("div", { style: { padding: '10px 12px', fontSize: TYPE_SCALE[13], color: '#7A7A82' } }, "No matches. Keep typing, or create one first.")) : items.map((it, i) => {
        const meta = mentionTypeMeta(it.type);
        return (React.createElement("div", { key: it.type + it.id, onMouseDown: (e) => { e.preventDefault(); onSelect(it); }, style: {
                padding: '9px 12px', fontSize: TYPE_SCALE[13.5], cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8],
                background: i === activeIndex ? '#2A2A30' : 'transparent', color: '#EFE7D2',
            } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, minWidth: 40, color: meta.color } }, meta.label),
            React.createElement("span", null, it.name || 'Unnamed')));
    })));
}


export function LinkPicker({ top, left, query, onQueryChange, items, onSelect }) {
    // Fade only (not the scale+translate .ink-dropdown-in treatment) since this element already
    // carries its own positioning transform — animating transform here would fight that anchor.
    return (React.createElement("div", { className: "ink-fade-in", style: {
            position: 'fixed', top, left, transform: 'translate(-50%, -100%)', background: '#1D1D22',
            border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], width: 240, maxHeight: 260, overflow: 'hidden',
            boxShadow: '0 12px 28px rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', flexDirection: 'column',
        } },
        React.createElement("input", { autoFocus: true, value: query, onChange: (e) => onQueryChange(e.target.value), placeholder: "Search characters, places, lore, events\u2026", style: { background: '#17171B', border: 'none', borderBottom: '1px solid #2A2A30', color: '#EFE7D2', padding: '9px 10px', fontSize: TYPE_SCALE[13] } }),
        React.createElement("div", { style: { overflowY: 'auto' } }, items.length === 0 ? (React.createElement("div", { style: { padding: '10px 12px', fontSize: TYPE_SCALE[12.5], color: '#7A7A82' } }, "No matches yet \u2014 create the entry first, then link it.")) : items.slice(0, 8).map((it) => {
            const meta = mentionTypeMeta(it.type);
            return (React.createElement("div", { key: it.type + it.id, onMouseDown: (e) => { e.preventDefault(); onSelect(it); }, style: {
                    padding: '8px 12px', fontSize: TYPE_SCALE[13], cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], color: '#EFE7D2',
                } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9], textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, minWidth: 38, color: meta.color } }, meta.label),
                React.createElement("span", null, it.name || 'Unnamed')));
        }))));
}
