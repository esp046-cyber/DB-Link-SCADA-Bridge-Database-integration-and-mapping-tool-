/* DB-Link SCADA Bridge - Canvas icon pack generator (PNG exports, no dependencies). */
(function (root) {
  'use strict';

  const ICONS = [
    { name: 'icon-72.png', size: 72 }, { name: 'icon-96.png', size: 96 }, { name: 'icon-128.png', size: 128 },
    { name: 'icon-144.png', size: 144 }, { name: 'icon-152.png', size: 152 }, { name: 'icon-192.png', size: 192 },
    { name: 'icon-384.png', size: 384 }, { name: 'icon-512.png', size: 512 },
    { name: 'icon-maskable-192.png', size: 192, maskable: true }, { name: 'icon-maskable-512.png', size: 512, maskable: true },
    { name: 'apple-touch-icon.png', size: 180, opaque: true },
    { name: 'favicon-16x16.png', size: 16 }, { name: 'favicon-32x32.png', size: 32 }
  ];

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Draws the SCADA -> DB emblem. Design grid is 512x512.
  function draw(ctx, size, opts) {
    opts = opts || {};
    const s = size / 512;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.scale(s, s);
    // background: maskable and opaque icons fill the full square (OS applies its own mask)
    ctx.fillStyle = '#0B0F19';
    if (opts.maskable || opts.opaque) ctx.fillRect(0, 0, 512, 512); else { rr(ctx, 0, 0, 512, 512, 96); ctx.fill(); }
    if (!opts.maskable && !opts.opaque) {
      ctx.strokeStyle = '#1E293B'; ctx.lineWidth = 8; rr(ctx, 16, 16, 480, 480, 84); ctx.stroke();
    }
    // maskable safe zone is the inner 80%; shrink the emblem to ~70%
    if (opts.maskable) { ctx.translate(256, 256); ctx.scale(0.7, 0.7); ctx.translate(-256, -256); }

    // SCADA node
    ctx.fillStyle = '#111827'; ctx.strokeStyle = '#10B981'; ctx.lineWidth = 10;
    rr(ctx, 48, 196, 112, 120, 14); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(68, 280); ctx.lineTo(92, 244); ctx.lineTo(112, 268); ctx.lineTo(140, 220);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();

    // bridge arrow
    ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 12; ctx.setLineDash([14, 12]);
    ctx.beginPath(); ctx.moveTo(160, 256); ctx.lineTo(244, 256); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#F59E0B'; ctx.beginPath(); ctx.moveTo(244, 236); ctx.lineTo(276, 256); ctx.lineTo(244, 276); ctx.closePath(); ctx.fill();

    // database cylinder
    ctx.fillStyle = 'rgba(14,165,233,0.18)';
    ctx.beginPath(); ctx.moveTo(264, 160); ctx.lineTo(264, 352); ctx.ellipse(346, 352, 82, 30, 0, Math.PI, 0, true); ctx.lineTo(428, 160); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#0EA5E9'; ctx.beginPath(); ctx.ellipse(346, 160, 82, 30, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0EA5E9'; ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(264, 160); ctx.lineTo(264, 352); ctx.ellipse(346, 352, 82, 30, 0, Math.PI, 0, true); ctx.lineTo(428, 160); ctx.stroke();
    ctx.lineWidth = 10;
    [224, 288].forEach((y) => { ctx.beginPath(); ctx.ellipse(346, y, 82, 30, 0, 0, Math.PI); ctx.stroke(); });
    ctx.restore();
  }

  function render(canvas, size, opts) {
    canvas.width = size; canvas.height = size;
    draw(canvas.getContext('2d'), size, opts);
    return canvas;
  }

  function toBlob(entry) {
    return new Promise((resolve) => {
      const c = document.createElement('canvas');
      render(c, entry.size, entry);
      c.toBlob((b) => resolve(b), 'image/png');
    });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function downloadAll(onProgress) {
    for (let i = 0; i < ICONS.length; i++) {
      const blob = await toBlob(ICONS[i]);
      download(blob, ICONS[i].name);
      if (onProgress) onProgress(i + 1, ICONS.length, ICONS[i].name);
      await wait(250); // browsers throttle rapid multi-downloads
    }
  }

  // Stores PNGs without compression into one ZIP so a single download holds the full pack.
  function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    if (!crc32.t) { crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c >>> 0; } }
    for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  async function buildZip() {
    const enc = new TextEncoder(); const files = []; const central = []; let offset = 0;
    const u16 = (n) => [n & 255, (n >> 8) & 255]; const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    for (const e of ICONS) {
      const data = new Uint8Array(await (await toBlob(e)).arrayBuffer());
      const name = enc.encode('icons/' + e.name); const crc = crc32(data);
      const lh = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)]);
      files.push(lh, name, data);
      central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += lh.length + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(ICONS.length), ...u16(ICONS.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob(files.concat(central, [end]), { type: 'application/zip' });
  }
  async function downloadZip() { download(await buildZip(), 'dblink-scada-icons.zip'); }

  root.IconGenerator = { ICONS, draw, render, downloadAll, downloadZip };
})(window);
