export async function autoScroll(page, steps = 8, delayMs = 600) {
  if (!steps) return;
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 0.9);
    });
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
