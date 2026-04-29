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
  const { ingredients, prefs, language } = req.body;

  console.log('Requête reçue - ingrédients:', ingredients, 'prefs:', prefs, 'langue:', language);

  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'No ingredients provided.' });
  }

  if (!process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY manquante !');
    return res.status(500).json({ error: 'API key missing.' });
  }

  const prefsText = prefs && prefs.length > 0 ? `Dietary preferences: ${prefs.join(', ')}.` : '';
  const lang = language || 'English';

  const prompt = `You are an expert nutritionist and chef. Generate ONE delicious healthy recipe using mainly these ingredients: ${ingredients.join(', ')}. ${prefsText}

IMPORTANT: Respond ENTIRELY in ${lang}. Every single word in the recipe (name, description, ingredients, steps, tip) must be in ${lang}.

The recipe must be:
- Nutritious and balanced
- Tasty and realistic to prepare
- Suitable for a healthy diet

Reply ONLY in valid JSON (no backticks, no markdown), in this exact format:
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
  "steps": ["Step in ${lang}"],
  "tip": "Health tip in ${lang}"
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
