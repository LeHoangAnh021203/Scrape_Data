import axios from 'axios';

async function postWithRetry(url, payload, attempt = 1) {
  const max = 4;
  const backoff = Math.min(2000 * 2 ** (attempt - 1), 15000);
  try {
    await axios.post(url, payload, { timeout: 15000 });
    return { url, ok: true };
  } catch (e) {
    if (attempt < max) {
      await new Promise(r => setTimeout(r, backoff));
      return postWithRetry(url, payload, attempt + 1);
    }
    return { url, ok: false, error: e.message };
  }
}

export async function fanOut(endpoints, dataArray) {
  if (!endpoints?.length) {
    console.log('⚠️  No fan-out endpoints configured. Skipping fan-out step.');
    return [];
  }
  
  if (!dataArray?.length) {
    console.log('⚠️  No data to send. Skipping fan-out step.');
    return [];
  }
  
  console.log(`📤 Sending ${dataArray.length} items to ${endpoints.length} endpoint(s)...`);
  const payload = dataArray; // send as an array; change if your API expects an object
  const results = await Promise.allSettled(endpoints.map(u => postWithRetry(u, payload)));
  
  let successCount = 0;
  let failCount = 0;
  
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      const { url, ok, error } = r.value;
      if (ok) {
        console.log(`✅ Sent -> ${url}`);
        successCount++;
      } else {
        console.log(`❌ Failed -> ${url}: ${error || 'Connection failed'}`);
        failCount++;
      }
    } else {
      console.log('❌ Fan-out error:', r.reason?.message || r.reason);
      failCount++;
    }
  });
  
  if (failCount === endpoints.length) {
    console.log('⚠️  All fan-out endpoints failed. Data is still saved to MongoDB.');
  } else if (successCount > 0) {
    console.log(`✅ Successfully sent to ${successCount}/${endpoints.length} endpoint(s)`);
  }
  
  return results;
}
