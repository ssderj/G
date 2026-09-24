import React, { useState, useRef } from 'react';
import { inputStyle } from './form-fields.jsx';
import { IconPlus, IconTrash } from './icons.jsx';
import { readLocalImageFile, validatePastedImageUrl } from './image-utils.jsx';
import { deleteUploadedImage, isUploadedMediaUrl, uploadImageDataUrl } from '../lib/mediaStorage.js';
import { EmptyState, QuickStatsCard } from './ui-cards.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { HouseCrest, houseBannerBackground } from '../worldbuilding/relationship-web.jsx';
import { READING_THEMES } from '../writing/reading-and-sound-settings.jsx';


export const selectStyle = {
    background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 10px',
    color: '#EFE7D2', fontSize: TYPE_SCALE[13.5], fontFamily: "'Inter', sans-serif",
};


// Adds one or more images to a gallery (e.g. a location's Images list). Uploading from the
// device's photo library or files is the primary path; pasting a URL remains available as a
// fallback, exactly as before.
export function ImageAdder({ onAdd }) {
    const fileInputRef = useRef(null);
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const handleFiles = async (fileList) => {
        const files = Array.from(fileList || []);
        if (!files.length)
            return;
        setBusy(true);
        setError('');
        for (const file of files) {
            try {
                // These galleries (a location's Images list, etc.) are part of the project's own
                // JSON, synced through kv_store on every autosave — the same whole-project blob
                // every embedded image bloats. Uploading here and storing the short URL instead
                // keeps that payload small without changing anything about how storage.set/
                // syncEngine.js work; a signed-out/offline writer still gets the data URL exactly
                // as before, so the gallery keeps working fully offline either way.
                const dataUrl = await readLocalImageFile(file);
                const uploadedUrl = await uploadImageDataUrl(dataUrl, 'project-images');
                onAdd(uploadedUrl || dataUrl);
            }
            catch (err) {
                setError((err && err.message) || "Couldn't load one of those images.");
            }
        }
        setBusy(false);
    };
    return (React.createElement("div", null,
        React.createElement("input", { ref: fileInputRef, type: "file", accept: "image/*", multiple: true, style: { display: 'none' }, onChange: (e) => { handleFiles(e.target.files); e.target.value = ''; } }),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement("button", { type: "button", disabled: busy, onClick: () => fileInputRef.current && fileInputRef.current.click(), style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: '#C89B3C',
                    color: '#17171B', border: 'none', borderRadius: RADIUS_SCALE[6], padding: '8px 12px',
                    fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                } }, busy ? 'Uploading\u2026' : 'Upload from device'),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, "or paste an image URL")),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 8 } },
            React.createElement("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "Paste an image URL\u2026", style: {
                    ...inputStyle(13, 400), background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 10px',
                } }),
            React.createElement("button", { disabled: !url.trim(), onClick: () => { const v = url.trim(); const problem = validatePastedImageUrl(v); if (problem) {
                        setError(problem);
                        return;
                    } onAdd(v); setUrl(''); setError(''); }, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: url.trim() ? '#2A2A30' : '#1D1D22',
                    color: url.trim() ? '#EFE7D2' : '#5C5C64', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 12px',
                    fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: url.trim() ? 'pointer' : 'default', flexShrink: 0,
                } },
                React.createElement(IconPlus, null),
                " Add")),
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98C8C', marginTop: 6 } }, error)));
}


// Single-image picker for one-image-at-a-time fields (a character's portrait, a map's background
// image). Upload from device is primary; a URL field remains as the secondary, alternative path.
// Controlled: `value` holds the current URL/data-URL, `onChange` receives the new one.
export function ImagePicker({ value, onChange, placeholder, maxDim, quality }) {
    const fileInputRef = useRef(null);
    const [urlDraft, setUrlDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const handleFile = async (file) => {
        if (!file)
            return;
        setBusy(true);
        setError('');
        try {
            // Same reasoning as ImageAdder above — this backs single-image fields (a
            // character's portrait, a map's background, a house's crest/banner, a publishing
            // cover) that are just as much a part of the synced project JSON. `value` is this
            // field's previous image, captured before the upload so a successful replace can
            // clean up the old uploaded object afterward.
            const previousValue = value;
            const dataUrl = await readLocalImageFile(file, maxDim || 1600, quality || 0.86);
            const uploadedUrl = await uploadImageDataUrl(dataUrl, 'project-images');
            onChange(uploadedUrl || dataUrl);
            if (uploadedUrl && isUploadedMediaUrl(previousValue)) {
                deleteUploadedImage(previousValue);
            }
        }
        catch (err) {
            setError((err && err.message) || "Couldn't load that image.");
        }
        finally {
            setBusy(false);
        }
    };
    return (React.createElement("div", null,
        React.createElement("input", { ref: fileInputRef, type: "file", accept: "image/*", style: { display: 'none' }, onChange: (e) => { handleFile(e.target.files && e.target.files[0]); e.target.value = ''; } }),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
            React.createElement("button", { type: "button", disabled: busy, onClick: () => fileInputRef.current && fileInputRef.current.click(), style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: '#C89B3C',
                    color: '#17171B', border: 'none', borderRadius: RADIUS_SCALE[6], padding: '8px 12px',
                    fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                } }, busy ? 'Uploading\u2026' : 'Upload photo'),
            value && React.createElement("button", { type: "button", onClick: () => {
                    if (isUploadedMediaUrl(value)) {
                        deleteUploadedImage(value);
                    }
                    onChange('');
                }, style: {
                    background: 'none', border: '1px solid #2A2A30', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6],
                    padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                } }, "Remove image")),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', margin: '8px 0 4px' } }, "or paste an image URL"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement("input", { placeholder: placeholder || "https://\u2026", value: urlDraft, onChange: (e) => setUrlDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && urlDraft.trim()) {
                        const v = urlDraft.trim();
                        const problem = validatePastedImageUrl(v);
                        if (problem) {
                            setError(problem);
                            return;
                        }
                        onChange(v);
                        setUrlDraft('');
                        setError('');
                    } }, style: {
                    flex: 1, background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 10px',
                    color: '#EFE7D2', fontSize: TYPE_SCALE[12.5], fontFamily: "'Inter', sans-serif",
                } }),
            React.createElement("button", { type: "button", disabled: !urlDraft.trim(), onClick: () => { const v = urlDraft.trim(); const problem = validatePastedImageUrl(v); if (problem) {
                        setError(problem);
                        return;
                    } onChange(v); setUrlDraft(''); setError(''); }, style: {
                    background: urlDraft.trim() ? '#2A2A30' : '#1D1D22', color: urlDraft.trim() ? '#EFE7D2' : '#5C5C64',
                    border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 12px', fontSize: TYPE_SCALE[12.5], cursor: urlDraft.trim() ? 'pointer' : 'default',
                } }, "Use link")),
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98C8C', marginTop: 6 } }, error)));
}


// Generic single-button notice modal — same visual shell as ConfirmDialog just below, for
// surfacing a failure that needs the person's attention rather than their yes/no decision. Used
// by the publishing flow (see lib/publish-flow.js) so a failed publish/unpublish is never just a
// console.warn no one sees: ink-root.jsx's Author Studio quick actions and
// project-workspace.jsx's Publishing Hub quick actions both render this when the remote
// listing+content steps don't both complete.
export function AlertDialog({ title, message, onClose, closeLabel }) {
    return (React.createElement("div", { className: "ink-modal-backdrop", style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 5000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }, onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); } },
        React.createElement("div", { className: "ink-modal-panel", style: {
                background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12],
                padding: 22, maxWidth: 380, width: '100%', boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: '#EFE7D2', marginBottom: 10 } }, title || 'Something went wrong'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#D9A6A6', lineHeight: 1.6, marginBottom: 22 } }, message),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end' } },
                React.createElement("button", { onClick: onClose, style: {
                        background: '#2A2A30', border: 'none', color: '#EFE7D2', borderRadius: RADIUS_SCALE[6],
                        padding: '8px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    } }, closeLabel || 'OK')))));
}


// ---------- Generic editable card list (World Bible, Glossary) ----------
export function ConfirmDialog({ message, confirmLabel, onCancel, onConfirm }) {
    return (React.createElement("div", { className: "ink-modal-backdrop", style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 5000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }, onMouseDown: (e) => { if (e.target === e.currentTarget)
            onCancel(); } },
        React.createElement("div", { className: "ink-modal-panel", style: {
                background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12],
                padding: 22, maxWidth: 380, width: '100%', boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: '#EFE7D2', marginBottom: 10 } }, "Are you sure?"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#A6A6AD', lineHeight: 1.6, marginBottom: 22 } }, message),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], justifyContent: 'flex-end' } },
                React.createElement("button", { onClick: onCancel, style: {
                        background: 'none', border: '1px solid #2A2A30', color: '#D9D2BE', borderRadius: RADIUS_SCALE[6],
                        padding: '8px 16px', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                    } }, "Cancel"),
                React.createElement("button", { onClick: onConfirm, style: {
                        background: '#5C2A2A', border: 'none', color: '#F5DCDC', borderRadius: RADIUS_SCALE[6],
                        padding: '8px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    } }, confirmLabel || 'Delete')))));
}


export function CardList({ items, fields, onAdd, onRemove, onChange, anchorPrefix, emptyText, addLabel, askConfirm, itemLabel, renderFooter, imageField, imageLabel, bannerField, bannerLabel, quickStatsFields }) {
    return (React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], maxWidth: 720 } },
        items.map((item) => (React.createElement("div", { key: item.id, id: anchorPrefix + '-' + item.id, style: { padding: 14, background: '#1D1D22', borderRadius: RADIUS_SCALE[8], border: '1px solid #2A2A30' } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8] } },
                React.createElement("input", { placeholder: fields[0].placeholder, value: item[fields[0].key] || '', onChange: (e) => onChange(item.id, fields[0].key, e.target.value), style: inputStyle(14, 600) }),
                React.createElement("button", { onClick: () => {
                        const label = itemLabel ? itemLabel(item) : (item[fields[0].key] || 'this entry');
                        askConfirm(`Delete "${label}"? This cannot be undone.`, () => onRemove(item.id));
                    }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex', flexShrink: 0 } },
                    React.createElement(IconTrash, null))),
            quickStatsFields && React.createElement(QuickStatsCard, { compact: true, rows: quickStatsFields.map((f) => ({ label: f.label, value: item[f.key], accent: f.accent })) }),
            bannerField && React.createElement("div", { style: { ...houseBannerBackground(item[bannerField] || ''), position: 'relative', height: 64, borderRadius: RADIUS_SCALE[8], marginTop: 10, overflow: 'visible' } },
                imageField && React.createElement("div", { style: { position: 'absolute', left: 12, bottom: -16 } },
                    React.createElement(HouseCrest, { url: item[imageField] || '', size: 40 }))),
            (bannerField || imageField) && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], flexWrap: 'wrap', marginTop: bannerField ? 26 : 10 } },
                bannerField && React.createElement("div", { style: { flex: '1 1 220px', minWidth: 200 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginBottom: 6 } }, bannerLabel || 'Banner'),
                    React.createElement(ImagePicker, { value: item[bannerField] || '', onChange: (v) => onChange(item.id, bannerField, v), placeholder: "Paste a banner image URL\u2026", maxDim: 1920, quality: 0.82 })),
                imageField && !bannerField && React.createElement(HouseCrest, { url: item[imageField] || '', size: 56 }),
                imageField && React.createElement("div", { style: { flex: '1 1 220px', minWidth: 200 } },
                    imageLabel && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginBottom: 6 } }, imageLabel),
                    React.createElement(ImagePicker, { value: item[imageField] || '', onChange: (v) => onChange(item.id, imageField, v), placeholder: "Paste a crest image URL\u2026", maxDim: 1000, quality: 0.9 }))),
            fields.slice(1).map((f) => (f.kind === 'textarea' ? (React.createElement("textarea", { key: f.key, placeholder: f.placeholder, value: item[f.key] || '', onChange: (e) => onChange(item.id, f.key, e.target.value), style: { ...inputStyle(14, 400), marginTop: 8, minHeight: 70, resize: 'vertical', lineHeight: 1.6 } })) : f.kind === 'select' ? (React.createElement("select", { key: f.key, value: item[f.key] || '', onChange: (e) => onChange(item.id, f.key, e.target.value), style: { ...selectStyle, marginTop: 8, width: 'auto' } }, f.options.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label)))) : (React.createElement("input", { key: f.key, placeholder: f.placeholder, value: item[f.key] || '', onChange: (e) => onChange(item.id, f.key, e.target.value), style: { ...inputStyle(13.5, 500), marginTop: 8 } })))),
            renderFooter && renderFooter(item)))),
        React.createElement("button", { onClick: onAdd, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 4, background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '9px 12px', fontSize: TYPE_SCALE[13], cursor: 'pointer', alignSelf: 'flex-start' } },
            React.createElement(IconPlus, null),
            " ",
            addLabel),
        items.length === 0 && React.createElement(EmptyState, { text: emptyText })));
}


// ---------- Reading Settings controls ----------
// A small segmented control — used for font family, page width, alignment, theme.
// `theme` is the active reading theme (READING_THEMES entry) so this renders correctly
// no matter which Light/Sepia/Dark palette the reader has selected.
export function SettingSegmented({ options, value, onChange, theme }) {
    const t = theme || READING_THEMES.dark;
    return React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap' } }, options.map((opt) => {
        const active = opt.value === value;
        return React.createElement("button", { key: opt.value, onClick: () => onChange(opt.value), style: {
                display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], cursor: 'pointer', borderRadius: RADIUS_SCALE[7],
                border: active ? '1px solid #C89B3C' : `1px solid ${t.border}`,
                background: active ? '#C89B3C22' : 'transparent', color: active ? '#C89B3C' : t.text,
                fontSize: TYPE_SCALE[12.5], fontWeight: 600, padding: '7px 11px', flex: options.length > 2 ? '1 1 0' : '0 0 auto',
                justifyContent: 'center', whiteSpace: 'nowrap',
            } },
            opt.swatch && React.createElement("span", { style: { width: 12, height: 12, borderRadius: '50%', background: opt.swatch, border: `1px solid ${t.border}`, flexShrink: 0 } }),
            opt.label);
    }));
}


export function SettingSlider({ label, value, min, max, step, onChange, display, theme }) {
    const t = theme || READING_THEMES.dark;
    return React.createElement("div", null,
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: t.text, fontWeight: 600 } }, label),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: t.muted } }, display)),
        React.createElement("input", { type: "range", min: min, max: max, step: step, value: value, onChange: (e) => onChange(parseFloat(e.target.value)), style: { width: '100%', accentColor: '#C89B3C' } }));
}


export function SettingToggle({ label, checked, onChange, theme }) {
    const t = theme || READING_THEMES.dark;
    return React.createElement("button", { onClick: () => onChange(!checked), style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
            background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', textAlign: 'left',
        } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: t.text, fontWeight: 600 } }, label),
        React.createElement("span", { style: {
                display: 'inline-flex', alignItems: 'center', width: 36, height: 20, borderRadius: RADIUS_SCALE[10], flexShrink: 0,
                background: checked ? '#C89B3C' : t.border, padding: 2, transition: 'background 0.15s ease',
            } },
            React.createElement("span", { style: {
                    width: 16, height: 16, borderRadius: '50%', background: t.panel,
                    transform: checked ? 'translateX(16px)' : 'translateX(0)', transition: 'transform 0.15s ease',
                } })));
}
