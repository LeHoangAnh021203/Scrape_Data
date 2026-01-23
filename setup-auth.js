import fs from 'fs';

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

// Update authentication settings
const authSettings = `
# Authentication Settings (for pages requiring login)
AUTH_EMAIL=admin@facewashfox.com
AUTH_USERNAME=admin@facewashfox.com
AUTH_PASSWORD=rW7SEu8J80R
`;

// Check if auth settings already exist
if (envContent.includes('AUTH_EMAIL=')) {
  console.log('✅ Authentication settings already configured');
} else {
  envContent += authSettings;
  fs.writeFileSync(envPath, envContent);
  console.log('✅ Added authentication settings to .env');
}

console.log('\n🔐 Authentication Configuration:');
console.log('- AUTH_EMAIL: admin@facewashfox.com');
console.log('- AUTH_USERNAME: admin@facewashfox.com');
console.log('- AUTH_PASSWORD: rW7SEu8J80R');
console.log('\n📋 The scraper will now automatically:');
console.log('1. Detect login forms on the page');
console.log('2. Fill in email/username and password');
console.log('3. Click login button');
console.log('4. Wait for successful authentication');
console.log('5. Proceed with data extraction');
