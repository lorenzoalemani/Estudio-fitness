const fs = require('fs');
const path = require('path');

// Asegurar carpeta icons
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Guardar versión SVG limpia en icons
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#0A0A0C" rx="80"/>
  <text x="250" y="160" text-anchor="middle" font-family="'Impact', 'Arial Black', sans-serif" font-size="110" font-weight="900" fill="#FFFFFF" letter-spacing="6">ESTUDIO</text>
  <text x="250" y="380" text-anchor="middle" font-family="'Impact', 'Arial Black', sans-serif" font-size="110" font-weight="900" fill="#FFFFFF" letter-spacing="6">FITNESS</text>
  <g transform="translate(250, 260)">
    <rect x="-170" y="-10" width="340" height="20" fill="#CC0000" rx="5"/>
    <rect x="-170" y="-6" width="340" height="12" fill="#FF2E2E" rx="3"/>
    <rect x="-160" y="-45" width="22" height="90" fill="#E50914" rx="4"/>
    <rect x="-135" y="-60" width="26" height="120" fill="#FF2E2E" rx="6"/>
    <rect x="-105" y="-75" width="30" height="150" fill="#D8000C" rx="8"/>
    <rect x="75" y="-75" width="30" height="150" fill="#D8000C" rx="8"/>
    <rect x="109" y="-60" width="26" height="120" fill="#FF2E2E" rx="6"/>
    <rect x="138" y="-45" width="22" height="90" fill="#E50914" rx="4"/>
  </g>
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon-512x512.svg'), svgContent);
fs.writeFileSync(path.join(iconsDir, 'icon-192x192.svg'), svgContent);
fs.writeFileSync(path.join(iconsDir, 'apple-touch-icon.svg'), svgContent);

console.log("✅ Iconos SVG creados en icons/");
