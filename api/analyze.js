export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, imageBase64, imageType } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const BD_TOKEN = process.env.BRIGHTDATA_TOKEN;

  if (!ANTHROPIC_KEY || !BD_TOKEN) {
    return res.status(500).json({ error: 'Missing API keys in environment' });
  }

  try {
    // Step 1: Claude analyzes the product
    const messages = imageBase64
      ? [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
          { type: 'text', text: 'Identify this product and find 6 clean safe alternatives.' }
        ]}]
      : [{ role: 'user', content: `Analyze and find 6 clean alternatives for: ${query}` }];

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: `You are Clean, Clear & Safe — an objective, technical product analyzer. Respond in the same language the user uses (Spanish or English).

Return ONLY a raw JSON object, no markdown, no code fences:
{
  "product_name": "Full product name identified",
  "category": "Category",
  "score": 65,
  "score_label": "CAUTION",
  "score_detail": "N compounds of concern identified",
  "compounds": [
    {
      "name": "Compound name",
      "risk": "HIGH|MEDIUM|MODERATE",
      "effect": "Technical explanation of health risk",
      "source": "Scientific sources"
    }
  ],
  "search_terms": ["specific amazon search term 1", "term 2", "term 3", "term 4", "term 5", "term 6"],
  "alternatives_why": ["Why alt 1 is cleaner", "Why alt 2", "Why alt 3", "Why alt 4", "Why alt 5", "Why alt 6"],
  "alternatives_scores": [94, 88, 81, 74, 70, 55],
  "alternatives_labels": ["CLEAN","CLEAN","CLEAN","ACCEPTABLE","ACCEPTABLE","CAUTION"]
}

Scoring: penalize heavily artificial colorants, preservatives, sweeteners, hidden sugar aliases, toxic compounds, endocrine disruptors, quats. Reward simple verifiable ingredients, organic.
Tiers: 90-100 CLEAN · 70-89 ACCEPTABLE · 50-69 CAUTION · below 50 AVOID.
search_terms must be specific real product names for Amazon search.`,
        messages
      })
    });

    const claudeData = await claudeRes.json();
    const txt = claudeData.content?.find(b => b.type === 'text')?.text || '';
    const analysis = JSON.parse(txt.replace(/```json|```/g, '').trim());

    // Step 2: Bright Data fetches real Amazon products
    const amazonProducts = await Promise.all(
      (analysis.search_terms || []).map(async (term) => {
        try {
          const bdRes = await fetch('https://api.brightdata.com/request', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${BD_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              zone: 'mcp_unlocker',
              url: `https://www.amazon.com/s?k=${encodeURIComponent(term)}`,
              format: 'raw'
            })
          });

          if (!bdRes.ok) return { title: term, url: `https://www.amazon.com/s?k=${encodeURIComponent(term)}`, image: null, price: null };

          const html = await bdRes.text();

          // Extract first product from Amazon search results
          const titleMatch = html.match(/class="a-size-medium a-color-base a-text-normal"[^>]*>([^<]+)</);
          const priceMatch = html.match(/class="a-price-whole">([^<]+)</);
          const imgMatch = html.match(/s-image[^>]+src="([^"]+)"/);
          const asinMatch = html.match(/data-asin="([A-Z0-9]{10})"/);

          const title = titleMatch ? titleMatch[1].trim() : term;
          const price = priceMatch ? `$${priceMatch[1].trim()}` : null;
          const image = imgMatch ? imgMatch[1] : null;
          const url = asinMatch
            ? `https://www.amazon.com/dp/${asinMatch[1]}`
            : `https://www.amazon.com/s?k=${encodeURIComponent(term)}`;

          return { title, price, image, url };
        } catch (e) {
          return { title: term, url: `https://www.amazon.com/s?k=${encodeURIComponent(term)}`, image: null, price: null };
        }
      })
    );

    return res.status(200).json({ analysis, amazonProducts });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
