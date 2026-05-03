const express = require('express');
const cors = require('cors');
const { franc } = require('franc-min');

function buildImageUrl(recipe, index = 0) {
  const queryParts = [
    recipe.image_query,
    recipe.name,
    ...(Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 2) : [])
  ]
    .filter(Boolean)
    .join(',')
    .replace(/[^\p{L}\p{N}, -]/gu, ' ')
    .trim();
  const encoded = encodeURIComponent(queryParts || 'healthy food');
  return `https://loremflickr.com/640/480/${encoded}/all?lock=${index + 1}`;
}

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
  const requestText = [...(ingredients || []), ...(prefs || [])].join(' ').trim();
  const francCode = requestText.length >= 3 ? franc(requestText, { minLength: 3 }) : 'und';
  const detectedLanguage = francCode === 'fra' ? 'fr' : francCode === 'spa' ? 'es' : 'en';
  const languageName = detectedLanguage === 'fr' ? 'French' : detectedLanguage === 'es' ? 'Spanish' : 'English';

  const prompt = `You are an expert nutritionist and chef. The user provided ingredients in any language. Generate ONE delicious healthy recipe using mainly these ingredients: ${ingredients.join(', ')}. ${prefsText}

IMPORTANT: The user's language has already been detected as ${languageName}. Respond entirely in ${languageName}.

The recipes must be:
- Nutritious and balanced
- Tasty and realistic to prepare
- Suitable for a healthy diet

Reply ONLY in valid JSON (no backticks, no markdown), in this exact format. Generate exactly 3 different recipe options. Translate all user-facing field values to the detected language, but keep the JSON keys exactly as shown. \`image_query\` must be short English food keywords suitable for searching a recipe photo:
{
  "recipes": [
    {
      "name": "Recipe name in detected language",
      "description": "Short appetizing description (1-2 sentences) in detected language",
      "time": "30 min",
      "servings": "2 servings",
      "difficulty": "Easy",
      "calories": "350 kcal",
      "image_query": "grilled chicken pasta",
      "nutrition": {
        "proteines": "28g",
        "glucides": "32g",
        "lipides": "12g",
        "fibres": "6g"
      },
      "ingredients": ["ingredient 1 with quantity in detected language", "ingredient 2 with quantity"],
      "steps": ["Step 1 in detected language...", "Step 2...", "Step 3..."],
      "tip": "Health tip or chef advice in detected language"
    }
  ]
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

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) payload = JSON.parse(match[0]);
      else throw new Error('Format JSON invalide');
    }
    const recipes = Array.isArray(payload.recipes) ? payload.recipes : [payload];
    const normalizedRecipes = recipes.slice(0, 3).map((recipe, index) => ({
      ...recipe,
      imageUrl: buildImageUrl(recipe, index)
    }));
    console.log('Recettes générées:', normalizedRecipes.map(r => r.name).join(' | '), 'lang:', detectedLanguage);
    res.json({ recipes: normalizedRecipes, _detectedLanguage: detectedLanguage });

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
