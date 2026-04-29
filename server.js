const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());

app.post('/api/recipe', async (req, res) => {
  const { ingredients, prefs } = req.body;

  console.log('Requête reçue - ingrédients:', ingredients, 'prefs:', prefs);

  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'Aucun ingrédient fourni.' });
  }

  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY manquante !');
    return res.status(500).json({ error: 'Clé API manquante côté serveur.' });
  }

  const prefsText = prefs && prefs.length > 0
    ? `Dietary preferences: ${prefs.join(', ')}.`
    : '';

  const prompt = `You are an expert nutritionist and chef. The user provided ingredients in any language. Generate ONE delicious healthy recipe using mainly these ingredients: ${ingredients.join(', ')}. ${prefsText}

IMPORTANT: Detect the language of the ingredients and respond in that SAME language. If ingredients are in French, respond entirely in French. If in English, respond in English. If mixed, use the dominant language.

The recipe must be:
- Nutritious and balanced
- Tasty and realistic to prepare
- Suitable for a healthy diet

Reply ONLY in valid JSON (no backticks, no markdown), in this exact format (translate ALL field values to the detected language, but keep the JSON keys exactly as shown):
{
  "name": "Recipe name in detected language",
  "description": "Short appetizing description (1-2 sentences) in detected language",
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
  "ingredients": ["ingredient 1 with quantity in detected language", "ingredient 2 with quantity"],
  "steps": ["Step 1 in detected language...", "Step 2...", "Step 3..."],
  "tip": "Health tip or chef advice in detected language"
}`;

  try {
    console.log('Appel API Groq...');
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    console.log('Réponse Groq status:', response.status);

    if (!response.ok) {
      console.error('Groq error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Erreur API Groq: ' + (data.error?.message || 'inconnue') });
    }

    const text = data.choices?.[0]?.message?.content?.trim() || '';
    console.log('Texte reçu:', text.substring(0, 100));

    let recipe;
    try {
      recipe = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) recipe = JSON.parse(match[0]);
      else throw new Error('Format JSON invalide');
    }

    console.log('Recette générée:', recipe.name);
    res.json(recipe);

  } catch (err) {
    console.error('Erreur serveur:', err.message);
    res.status(500).json({ error: 'Erreur interne: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'NutriChef API en ligne ✅', apiKey: !!process.env.GROQ_API_KEY });
});

app.listen(PORT, () => {
  console.log(`NutriChef backend démarré sur le port ${PORT}`);
  console.log(`Clé API présente: ${!!process.env.GROQ_API_KEY}`);
});
