export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, imageBase64, imageType } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
  if (!RAPIDAPI_KEY) return res.status(500).json({ error: 'Missing RAPIDAPI_KEY' });

  try {
    const messages = imageBase64
      ? [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
          { type: 'text', text: 'Identify this product and analyze it.' }
        ]}]
      : [{ role: 'user', content: `Analyze this product: ${query}` }];

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `You are Clean, Clear & Safe — an objective technical product analyzer. Respond in the same language the user uses (Spanish or English).

Return ONLY a raw JSON object, no markdown, no code fences, no extra text:
{
  "product_name": "Full product name",
  "category": "Category (Food, Hygiene, Cleaning, Medicine, Clothing)",
  "score": 45,
  "score_label": "AVOID",
  "score_detail": "5 compounds of concern identified",
  "compounds": [
    {
      "name": "Compound name",
      "risk": "HIGH",
      "effect": "Health risk explanation",
      "source": "EWG / PubChem / FDA / EFSA"
    }
  ],
  "alternatives": [
    {
      "search_query": "specific amazon search term for a real clean product",
      "score": 92,
      "label": "CLEAN",
      "why": "Why this is a safer alternative"
    }
  ]
}

Rules:
- alternatives must have exactly 6 items
- search_query must be specific real product names findable on Amazon US
- Scoring: 90-100 CLEAN · 70-89 ACCEPTABLE · 50-69 CAUTION · below 50 AVOID
- Penalize: quats, parabens, artificial dyes, PFAS, endocrine disruptors, artificial preservatives
- Reward: organic, EWG verified, simple ingredient lists`,
        messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ error: `Claude API error ${claudeRes.status}: ${err}` });
    }

    const claudeData = await claudeRes.json();
    const txt = claudeData.content?.find(b => b.type === 'text')?.text || '';

    let analysis;
    try {
      analysis = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch (e) {
      return res.status(500).json({ error: `JSON parse failed: ${e.message}`, raw: txt.slice(0, 300) });
    }

    const amazonProducts = await Promise.all(
      (analysis.alternatives || []).map(async (alt) => {
        try {
          const url = `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(alt.search_query)}&page=1&country=US&sort_by=RELEVANCE&product_condition=ALL`;
          const r = await fetch(url, {
            method: 'GET',
            headers: {
              'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com',
              'x-rapidapi-key': RAPIDAPI_KEY
            }
          });

          if (!r.ok) {
            return { title: alt.search_query, score: alt.score, label: alt.label, why: alt.why, price: null, image: null, url: `https://www.amazon.com/s?k=${encodeURIComponent(alt.search_query)}` };
          }

          const data = await r.json();
          const product = data?.data?.products?.[0];

          if (!product) {
            return { title: alt.search_query, score: alt.score, label: alt.label, why: alt.why, price: null, image: null, url: `https://www.amazon.com/s?k=${encodeURIComponent(alt.search_query)}` };
          }

          return {
            title: product.product_title || alt.search_query,
            score: alt.score,
            label: alt.label,
            why: alt.why,
            price: product.product_price || null,
            image: product.product_photo || null,
            url: product.product_url || `https://www.amazon.com/s?k=${encodeURIComponent(alt.search_query)}`
          };
        } catch (e) {
          return { title: alt.search_query, score: alt.score, label: alt.label, why: alt.why, price: null, image: null, url: `https://www.amazon.com/s?k=${encodeURIComponent(alt.search_query)}` };
        }
      })
    );

    return res.status(200).json({ analysis, amazonProducts });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
