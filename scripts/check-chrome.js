import fs from 'node:fs';

const paths = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
  '/opt/render/.cache/puppeteer/bin/chrome'
];

const checkPath = (p) => {
  if (!p) {
    console.log('path missing');
    return;
  }
  try {
    const stats = fs.statSync(p);
    const executable = Boolean(stats.mode & fs.constants.S_IXUSR);
    console.log(`check: ${p} -> exists, executable=${executable}`);
  } catch (error) {
    console.log(`check: ${p} -> error: ${error.message}`);
  }
};

paths.forEach(checkPath);
