const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret'] }));
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
const { ingredients, prefs, language, userId, goal } = req.body;
const lang = language || 'English';

  if (!ingredients || ingredients.length === 0) return res.status(400).json({ error: 'No ingredients provided.' });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'API key missing.' });

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

const goalTexts = {
  muscle_gain:  'The user wants to BUILD MUSCLE (prise de masse): prioritize high calories (500+ kcal), high protein (30g+), complex carbs, healthy fats.',
  health:       'The user wants GENERAL HEALTH: balanced macros, lots of vegetables, antioxidants, whole foods.',
  high_protein: 'The user wants HIGH PROTEIN recipes: minimum 35g protein per serving, lean meats, legumes, eggs, dairy.',
  low_budget:   'The user wants LOW BUDGET recipes: use cheap everyday ingredients, no expensive items, simple pantry staples.',
  weight_loss:  'The user wants WEIGHT LOSS: keep calories under 400 kcal, high fiber, low fat, lots of vegetables.',
  energy:       'The user wants ENERGY & SPORT: complex carbs for sustained energy, electrolytes, pre/post workout friendly.',
};
const goalText = goal && goalTexts[goal] ? `GOAL: ${goalTexts[goal]}` : '';

const prompt = `You are an expert nutritionist and chef. Generate exactly 3 different delicious healthy recipes using mainly these ingredients: ${ingredients.join(', ')}. ${prefsText} ${goalText}

IMPORTANT: Respond ENTIRELY in ${lang}. Every single word must be in ${lang}.
${goalText ? `IMPORTANT: Every recipe MUST strictly follow the goal above. Adapt ingredients, portions and nutrition accordingly.` : ''}

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
  { role: 'system', content: 'You are Chef AI, an expert culinary assistant for NutriChef. You specialize in cooking techniques, recipes, ingredient substitutions, nutrition, food science, and healthy eating. When you give a recipe, ALWAYS include a nutrition section at the end with: Calories, Protein, Carbs, Fat, and Fiber per serving. Be warm, concise and practical. Use **bold** for key terms. Always focus on food and cooking. If asked something unrelated, politely redirect.' },
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

// ── ADMIN ──
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-secret'];
  if (!auth || auth !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=*`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const data = await response.json();
  res.json(data);
});

// ── FIX: PATCH au lieu de POST pour mettre à jour le plan ──
app.post('/api/admin/set-plan', requireAdmin, async (req, res) => {
  const { userId, plan } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: 'userId et plan requis' });

  const response = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ plan, updated_at: new Date().toISOString() })
  });

  const text = await response.text();
  console.log('Supabase set-plan response:', response.status, text);

  res.json({ success: true, userId, plan });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [users, usage] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=plan`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    }).then(r => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/usage?select=type`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    }).then(r => r.json())
  ]);
  const planCounts = users.reduce((acc, u) => { acc[u.plan] = (acc[u.plan] || 0) + 1; return acc; }, {});
  const usageCounts = usage.reduce((acc, u) => { acc[u.type] = (acc[u.type] || 0) + 1; return acc; }, {});
  res.json({ plans: planCounts, usage: usageCounts, totalUsers: users.length });
});
app.post('/api/meal-plan', async (req, res) => {
  const { userId, date, meal_type, recipe_data } = req.body;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/meal_plans`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, date, meal_type, recipe_data })
  });
  res.json({ success: r.ok });
});

app.get('/api/meal-plan', async (req, res) => {
  const { userId, from, to } = req.query;
  if (!userId) return res.status(401).json({ error: 'Not logged in' });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/meal_plans?user_id=eq.${userId}&date=gte.${from}&date=lte.${to}&select=*`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const data = await r.json();
  res.json(data);
});

app.delete('/api/meal-plan/:id', async (req, res) => {
  const { id } = req.params;
  await fetch(`${SUPABASE_URL}/rest/v1/meal_plans?id=eq.${id}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  res.json({ success: true });
});
app.listen(PORT, () => console.log(`NutriChef backend started on port ${PORT}`));

// ── STRIPE ──
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_BASIC = 'price_1TTTfMCaAJJZTXvh1JcmWTtE';
const PRICE_PRO = 'price_1TTTfjCaAJJZTXvhjOaiAxVr';

async function stripeRequest(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  return res.json();
}

app.post('/api/create-checkout', async (req, res) => {
  const { priceId, userId, userEmail } = req.body;
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe not configured.' });
  if (!priceId || !userId) return res.status(400).json({ error: 'Missing priceId or userId.' });

  try {
    const session = await stripeRequest('/checkout/sessions', 'POST', {
      'payment_method_types[]': 'card',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'mode': 'subscription',
      'customer_email': userEmail || '',
      'metadata[user_id]': userId,
      'metadata[price_id]': priceId,
      'success_url': 'https://nutritrack-realty-muse.vercel.app/?success=true',
      'cancel_url': 'https://nutritrack-realty-muse.vercel.app/?canceled=true',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const payload = req.body.toString();
    event = JSON.parse(payload);
  } catch (err) {
    return res.status(400).send('Webhook error: ' + err.message);
  }

  const session = event.data?.object;
  const userId = session?.metadata?.user_id;
  const priceId = session?.metadata?.price_id || session?.items?.data?.[0]?.price?.id;

  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.updated') {
    if (!userId) return res.json({ received: true });

    let plan = 'free';
    if (priceId === PRICE_PRO) plan = 'pro';
    else if (priceId === PRICE_BASIC) plan = 'basic';

    await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ user_id: userId, plan, updated_at: new Date().toISOString() })
    });

    console.log(`Plan updated: user ${userId} → ${plan}`);
  }

  if (event.type === 'customer.subscription.deleted') {
    if (!userId) return res.json({ received: true });
    await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ plan: 'free', updated_at: new Date().toISOString() })
    });
    console.log(`Subscription cancelled: user ${userId} → free`);
  }

  res.json({ received: true });
});
