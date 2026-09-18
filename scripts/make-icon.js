// Builds the application icon from the splash logo.
//
//     node scripts/make-icon.js
//
// Writes build/icon.ico (what electron-builder puts on the .exe, the taskbar
// and the Start menu) and build/icon.png, plus the individual sizes so they can
// be looked at.
//
// ## The wordmark is deliberately thrown away
//
// The splash art is a mark — ink flowing into pixels — above the words PROSE
// ENGINE. The words are the first thing to go. An icon is seen at 16 and 32
// pixels in a taskbar, where a wordmark is an unreadable grey smear; the mark
// alone still reads as a shape and a colour at that size, which is all an icon
// has to do. The name is written next to it by Windows.
//
// ## And the white background with it
//
// The source is a white JPEG-ish webp with no alpha. A white square icon looks
// like a missing icon on a light taskbar, so the background is made
// transparent here rather than by hand.
//
// It is done per pixel from BOTH darkness and colourfulness, not from
// brightness alone. The mark fades from near-black ink into bright cyan
// pixels, and a plain luminance key would have dissolved that cyan trail along
// with the background — the brightest, most saturated part of the artwork is
// the part that means something.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const APP = path.join(__dirname, '..');
const SOURCE = path.join(APP, 'views', 'public', 'images', 'prose-engine-logo.webp');
const OUT = path.join(APP, 'build');

// Windows uses every one of these: 16 in the title bar, 32 in the taskbar, 48
// in Explorer, 256 for the large tile and the installer.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** How much of the source, from the top, is the mark rather than the words. */
const MARK_HEIGHT = 0.60;

/**
 * How much of the mark, from the left, becomes the icon.
 *
 * The whole mark is a wide ribbon — ink blot, swoosh, pixel trail — about two
 * and a half times wider than it is tall. Squared off for an icon, it becomes a
 * thin band across the middle of the tile, and at 16 and 24 pixels it is an
 * illegible smear. Rendered at every size and looked at, which is the only way
 * to judge this: the blot alone is still recognisable at 16px, the full ribbon
 * is not readable below about 64.
 *
 * So the icon is the blot. It loses the pixel trail, which is the part that
 * carries the idea — but an icon's whole job is to be recognised in a taskbar,
 * and the logo is still the logo everywhere it has room to be.
 */
const MARK_WIDTH = 0.40;

/**
 * Replaces the white field with transparency.
 *
 * alpha = max(how dark it is, how colourful it is), so near-white pixels
 * vanish, ink stays solid, and the cyan trail keeps its edges.
 */
async function keyOutWhite(input) {
    const { data, info } = await sharp(input)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const pixels = Buffer.from(data);

    for (let i = 0; i < pixels.length; i += info.channels) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);

        const darkness = 255 - max;        // how far from white
        const colourfulness = max - min;   // how far from grey

        // Scaled up so soft edges do not end up half-transparent and muddy.
        const alpha = Math.min(255, Math.round(Math.max(darkness, colourfulness) * 1.6));
        pixels[i + 3] = alpha;
    }

    return sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .png()
        .toBuffer();
}

/**
 * An .ico file, assembled by hand.
 *
 * Every icon here is a PNG inside the container, which Windows has understood
 * since Vista and which avoids the BMP-with-an-upside-down-mask format
 * entirely. Doing it here rather than adding a dependency: the whole format is
 * a six-byte header and a sixteen-byte entry per image.
 */
function buildIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);              // reserved
    header.writeUInt16LE(1, 2);              // 1 = icon
    header.writeUInt16LE(images.length, 4);

    const entries = [];
    let offset = 6 + images.length * 16;

    for (const { size, data } of images) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);   // 0 means 256
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2);              // palette size, 0 for true colour
        entry.writeUInt8(0, 3);              // reserved
        entry.writeUInt16LE(1, 4);           // colour planes
        entry.writeUInt16LE(32, 6);          // bits per pixel
        entry.writeUInt32LE(data.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += data.length;
    }

    return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

(async () => {
    if (!fs.existsSync(SOURCE)) {
        console.error(`No logo at ${SOURCE}`);
        process.exit(1);
    }

    fs.mkdirSync(OUT, { recursive: true });

    const meta = await sharp(SOURCE).metadata();
    console.log(`source ${meta.width}x${meta.height}`);

    // Take the mark, drop the words.
    const markOnly = await sharp(SOURCE)
        .extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * MARK_HEIGHT) })
        .png()
        .toBuffer();

    const keyed = await keyOutWhite(markOnly);

    // Trim what is now transparent, so the art fills the icon instead of
    // floating in the middle of the space the artboard happened to have.
    const wholeMark = await sharp(keyed).trim({ threshold: 10 }).toBuffer();
    const wholeMeta = await sharp(wholeMark).metadata();
    console.log(`mark trimmed to ${wholeMeta.width}x${wholeMeta.height}`);

    // Keep the blot; see MARK_WIDTH.
    const cropped = await sharp(wholeMark)
        .extract({ left: 0, top: 0, width: Math.round(wholeMeta.width * MARK_WIDTH), height: wholeMeta.height })
        .png()
        .toBuffer();

    const trimmed = await sharp(cropped).trim({ threshold: 10 }).toBuffer();
    const trimmedMeta = await sharp(trimmed).metadata();
    console.log(`icon art ${trimmedMeta.width}x${trimmedMeta.height}`);

    // Square it, with a small margin so the shape is not welded to the edges.
    const side = Math.round(Math.max(trimmedMeta.width, trimmedMeta.height) * 1.12);
    const square = await sharp({
        create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
        .composite([{ input: trimmed, gravity: 'centre' }])
        .png()
        .toBuffer();

    const images = [];
    for (const size of SIZES) {
        const data = await sharp(square)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png({ compressionLevel: 9 })
            .toBuffer();

        images.push({ size, data });
        fs.writeFileSync(path.join(OUT, `icon-${size}.png`), data);
    }

    fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(images));
    fs.writeFileSync(path.join(OUT, 'icon.png'), images[images.length - 1].data);

    const kb = Math.round(fs.statSync(path.join(OUT, 'icon.ico')).size / 1024);
    console.log(`build/icon.ico  (${SIZES.join(', ')} px, ${kb} KB)`);
    console.log('build/icon.png  (256 px)');
})().catch(err => { console.error(err.message); process.exit(1); });
