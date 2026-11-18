// Simple test to verify the plugin structure is correct
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if required files exist
const requiredFiles = ['package.json', 'index.ts', 'README.md', 'LICENSE'];
const missingFiles = [];

for (const file of requiredFiles) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) {
    missingFiles.push(file);
  }
}

if (missingFiles.length > 0) {
  console.error('Missing required files:', missingFiles);
  process.exit(1);
}

// Check package.json content
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  if (!packageJson.name || !packageJson.version) {
    console.error('Invalid package.json: missing name or version');
    process.exit(1);
  }
  
  if (!packageJson.pi || !packageJson.pi.extensions) {
    console.error('Invalid package.json: missing pi.extensions configuration');
    process.exit(1);
  }
  
  console.log('✓ All files present and package.json structure is valid');
} catch (err) {
  console.error('Error reading package.json:', err.message);
  process.exit(1);
}

console.log('✓ Plugin structure validation passed');