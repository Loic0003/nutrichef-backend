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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY manquante !');
    return res.status(500).json({ error: 'Clé API manquante côté serveur.' });
  }

  const prefsText = prefs && prefs.length > 0
    ? `Préférences: ${prefs.join(', ')}.`
    : '';

  const prompt = `Tu es un nutritionniste et chef cuisinier expert. Génère UNE recette santé délicieuse en français en utilisant principalement ces ingrédients: ${ingredients.join(', ')}. ${prefsText}

La recette doit être:
- Nutritive et équilibrée
- Savoureuse et réaliste à préparer
- Adaptée à une alimentation saine

Réponds UNIQUEMENT en JSON valide (sans backticks, sans markdown), dans ce format exact:
{
  "name": "Nom de la recette",
  "description": "Courte description appétissante (1-2 phrases)",
  "time": "30 min",
  "servings": "2 personnes",
  "difficulty": "Facile",
  "calories": "350 kcal",
  "nutrition": {
    "proteines": "28g",
    "glucides": "32g",
    "lipides": "12g",
    "fibres": "6g"
  },
  "ingredients": ["ingrédient 1 avec quantité", "ingrédient 2 avec quantité"],
  "steps": ["Étape 1...", "Étape 2...", "Étape 3..."],
  "tip": "Conseil santé ou astuce de chef"
}`;

  try {
    console.log('Appel API Anthropic...');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    console.log('Réponse Anthropic status:', response.status);

    if (!response.ok) {
      console.error('Anthropic error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Erreur API Anthropic: ' + (data.error?.message || 'inconnue') });
    }

    const text = data.content?.map(b => b.text || '').join('').trim();
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
  res.json({ status: 'NutriChef API en ligne ✅', apiKey: !!process.env.ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`NutriChef backend démarré sur le port ${PORT}`);
  console.log(`Clé API présente: ${!!process.env.ANTHROPIC_API_KEY}`);
});
