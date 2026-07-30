import fetch from 'node-fetch';

export const handler = async (event, context) => {
  const siteUrl = process.env.SITE_URL || 'https://volgo-stays.com';
  const secretToken = process.env.CRON_SECRET || 'volgo-cron-secret-123';
  
  console.log(`Cron Trigger: invoking calendar sync on ${siteUrl}`);
  try {
    const res = await fetch(`${siteUrl}/api/cron/sync`, {
      headers: {
        'Authorization': `Bearer ${secretToken}`
      }
    });
    
    if (!res.ok) {
      throw new Error(`Cron response failed with status ${res.status}`);
    }
    
    const result = await res.json();
    console.log("Cron execution succeeded:", result);
    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
  } catch (err) {
    console.error("Cron trigger execution error:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
