import fs from 'fs';
import path from 'path';

// Read current .env file
const envPath = '.env';
let envContent = '';

try {
  envContent = fs.readFileSync(envPath, 'utf8');
  console.log('📄 Found existing .env file');
} catch (error) {
  console.log('📄 Creating new .env file');
  envContent = '';
}

// Update or add EXTRACTION_STRATEGY
if (envContent.includes('EXTRACTION_STRATEGY=')) {
  envContent = envContent.replace(
    /EXTRACTION_STRATEGY=.*/,
    'EXTRACTION_STRATEGY=NETWORK'
  );
  console.log('✅ Updated EXTRACTION_STRATEGY to NETWORK');
} else {
  envContent += '\n# Extraction Strategy\nEXTRACTION_STRATEGY=NETWORK\n';
  console.log('✅ Added EXTRACTION_STRATEGY=NETWORK');
}

// Write updated content
fs.writeFileSync(envPath, envContent);
console.log('💾 Configuration updated successfully!');
console.log('\n📋 Current configuration:');
console.log('- EXTRACTION_STRATEGY: NETWORK');
console.log('- This will use API calls instead of DOM selectors');
