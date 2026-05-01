const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
app.use(express.json());

app.post('/api/recipe', async (req, res) => {
  const { ingredients, prefs, language } = req.body;
  console.log('Requête reçue:', ingredients, prefs, language);

  if (!ingredients || ingredients.length === 0) return res.status(400).json({ error: 'No ingredients provided.' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'API key missing.' });

  const prefsText = prefs && prefs.length > 0 ? `Dietary preferences: ${prefs.join(', ')}.` : '';
  const lang = language || 'English';

  const prompt = `You are an expert nutritionist and chef. Generate exactly 3 different delicious healthy recipes using mainly these ingredients: ${ingredients.join(', ')}. ${prefsText}

IMPORTANT: Respond ENTIRELY in ${lang}. Every single word must be in ${lang}.

Reply ONLY in valid JSON (no backticks, no markdown):
{
  "recipes": [
    {
      "name": "Recipe name in ${lang}",
      "description": "Short appetizing description in ${lang}",
      "time": "30 min",
      "servings": "2 servings",
      "difficulty": "Easy",
      "calories": "350 kcal",
      "nutrition": {
        "proteines": "28g",
        "glucides": "32g",
        "lipides": "12g",
        "fibres": "6g"
      },
      "ingredients": ["ingredient with quantity in ${lang}"],
      "steps": ["Step 1 in ${lang}", "Step 2 in ${lang}", "Step 3 in ${lang}"],
      "tip": "Health tip in ${lang}"
    }
  ]
}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: 'Groq error: ' + (data.error?.message || 'unknown') });

    const text = data.choices?.[0]?.message?.content?.trim() || '';
    console.log('Texte reçu:', text.substring(0, 100));

    let payload;
    try { payload = JSON.parse(text); }
    catch { const match = text.match(/\{[\s\S]*\}/); if (match) payload = JSON.parse(match[0]); else throw new Error('Invalid JSON'); }

    const recipes = Array.isArray(payload.recipes) ? payload.recipes : [payload];
    console.log('Recettes:', recipes.map(r => r.name).join(' | '));
    res.json({ recipes: recipes.slice(0, 3) });

  } catch (err) {
    console.error('Erreur:', err.message);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'NutriChef API en ligne ✅', apiKey: !!process.env.GROQ_API_KEY }));
app.listen(PORT, () => console.log(`NutriChef backend started on port ${PORT}`));
