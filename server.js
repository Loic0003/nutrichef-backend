require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
app.use(express.json());

// Plan limits
const PLANS = {
  free:  { recipes_per_day: 3,   chat_per_window: 0,   chat_window_hours: 0 },
  basic: { recipes_per_day: 30,  chat_per_window: 6,   chat_window_hours: 2.5 },
  pro:   { recipes_per_day: 9999, chat_per_window: 9999, chat_window_hours: 1 },
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getUserPlan(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 'free';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const data = await res.json();
  return data?.[0]?.plan || 'free';
}

async function countUsage(userId, type, windowHours) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${userId}&type=eq.${type}&created_at=gte.${since}&select=id`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Prefer': 'count=exact' } }
  );
  const count = res.headers.get('content-range')?.split('/')[1];
  return parseInt(count || '0');
}

async function logUsage(userId, type) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/usage`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, type })
  });
}

// ── RECIPE ENDPOINT ──
app.post('/api/recipe', async (req, res) => {
  const { ingredients, prefs, language, userId } = req.body;

  if (!ingredients || ingredients.length === 0) return res.status(400).json({ error: 'No ingredients provided.' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'API key missing.' });

  // Check limits if userId provided
  if (userId) {
    const plan = await getUserPlan(userId);
    const limits = PLANS[plan] || PLANS.free;
    const used = await countUsage(userId, 'recipe', 24);
    if (used >= limits.recipes_per_day) {
      return res.status(429).json({
        error: 'limit_reached',
        plan,
        used,
        limit: limits.recipes_per_day,
        message: plan === 'free'
          ? 'You have reached your daily limit of 3 recipes. Upgrade to get more!'
          : `Daily limit of ${limits.recipes_per_day} recipes reached.`
      });
    }
  }

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
      "nutrition": { "proteines": "28g", "glucides": "32g", "lipides": "12g", "fibres": "6g" },
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
    let payload;
    try { payload = JSON.parse(text); }
    catch { const match = text.match(/\{[\s\S]*\}/); if (match) payload = JSON.parse(match[0]); else throw new Error('Invalid JSON'); }

    const recipes = Array.isArray(payload.recipes) ? payload.recipes : [payload];

    // Log usage
    if (userId) await logUsage(userId, 'recipe');

    res.json({ recipes: recipes.slice(0, 3) });

  } catch (err) {
    console.error('Recipe error:', err.message);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

// ── CHAT ENDPOINT ──
app.post('/api/chat', async (req, res) => {
  const { messages, userId } = req.body;

  if (!messages || messages.length === 0) return res.status(400).json({ error: 'No messages provided.' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'API key missing.' });

  // Check limits
  if (userId) {
    const plan = await getUserPlan(userId);
    const limits = PLANS[plan] || PLANS.free;

    if (limits.chat_per_window === 0) {
      return res.status(403).json({
        error: 'plan_required',
        message: 'Chef AI is available on Basic and Pro plans. Upgrade to chat!'
      });
    }

    if (limits.chat_per_window < 9999) {
      const used = await countUsage(userId, 'chat', limits.chat_window_hours);
      if (used >= limits.chat_per_window) {
        return res.status(429).json({
          error: 'limit_reached',
          plan,
          used,
          limit: limits.chat_per_window,
          message: `You've used ${used}/${limits.chat_per_window} Chef AI messages in the last ${limits.chat_window_hours}h. Try again later or upgrade to Pro!`
        });
      }
    }
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: 'You are Chef AI, an expert culinary assistant for NutriChef. You specialize in cooking techniques, recipes, ingredient substitutions, nutrition, food science, and healthy eating. Be warm, concise and practical. Use **bold** for key terms. Always focus on food and cooking. If asked something unrelated, politely redirect.' },
          ...messages.slice(-12)
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Error' });

    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not respond.';

    if (userId) await logUsage(userId, 'chat');

    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

// ── GET USER STATUS ──
app.get('/api/status', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ plan: 'free', recipeUsed: 0, recipeLimit: 3 });

  const plan = await getUserPlan(userId);
  const limits = PLANS[plan] || PLANS.free;
  const recipeUsed = await countUsage(userId, 'recipe', 24);
  const chatUsed = limits.chat_per_window < 9999 ? await countUsage(userId, 'chat', limits.chat_window_hours) : 0;

  res.json({
    plan,
    recipeUsed,
    recipeLimit: limits.recipes_per_day,
    chatUsed,
    chatLimit: limits.chat_per_window,
    chatWindowHours: limits.chat_window_hours
  });
});

app.get('/', (req, res) => res.json({ status: 'NutriChef API en ligne ✅', apiKey: !!process.env.GROQ_API_KEY }));
app.listen(PORT, () => console.log(`NutriChef backend started on port ${PORT}`));
