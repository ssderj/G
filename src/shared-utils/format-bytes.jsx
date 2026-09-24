import React from 'react';


export function formatBytes(n) {
    if (n < 1024 * 1024)
        return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
