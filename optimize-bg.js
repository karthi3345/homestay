import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputDir = path.join(__dirname, 'assets', 'BG');
const outputDir = path.join(__dirname, 'public', 'assets', 'bg-optimized');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function optimizeImages() {
  const files = fs.readdirSync(inputDir).filter(f => f.match(/\.(png|jpe?g)$/i));
  
  if (files.length === 0) {
    console.log('No images found in assets/BG');
    return;
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const inputPath = path.join(inputDir, file);
    const outputFileName = `bg-${i + 1}.png`;
    const outputPath = path.join(outputDir, outputFileName);
    
    console.log(`Processing ${file}...`);
    await sharp(inputPath)
      .resize(1920, 1080, { fit: 'cover', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outputPath);
      
    console.log(`Saved optimized image: ${outputFileName}`);
  }
  
  console.log('All images optimized successfully!');
}

optimizeImages().catch(err => {
  console.error('Error optimizing images:', err);
});
