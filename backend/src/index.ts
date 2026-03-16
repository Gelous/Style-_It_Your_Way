import googleTrends from 'google-trends-api';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, Modality } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ port: 4002 });

// Persistence Configuration
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'siyw';
let storage: Storage | null = null;
try { storage = new Storage(); } catch (e) {}

// Helper to save data (Scoped by User)
async function saveToPersistence(userId: string, fileName: string, data: any) {
  const cloudPath = `${userId}/${fileName}`;
  try {
    if (storage) {
        await storage.bucket(BUCKET_NAME).file(cloudPath).save(JSON.stringify(data, null, 2));
        return;
    }
  } catch (err) {}
  
  // Local Fallback
  const userDir = path.join(process.cwd(), 'data', userId);
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, fileName), JSON.stringify(data, null, 2));
}

// Helper to load data (Scoped by User)
async function loadFromPersistence(userId: string, fileName: string, defaultValue: any) {
  const cloudPath = `${userId}/${fileName}`;
  try {
    if (storage) {
        const [exists] = await storage.bucket(BUCKET_NAME).file(cloudPath).exists();
        if (exists) {
            const [content] = await storage.bucket(BUCKET_NAME).file(cloudPath).download();
            return JSON.parse(content.toString());
        }
    }
  } catch (err) {}

  // Local Fallback
  const localPath = path.join(process.cwd(), 'data', userId, fileName);
  try {
    const content = await fs.readFile(localPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) { return defaultValue; }
}

// User Database (Local JSON)
const USERS_FILE = path.join(process.cwd(), 'local_users.json');
async function getUsers() {
    try {
        const content = await fs.readFile(USERS_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (e) { return []; }
}
async function saveUsers(users: any[]) {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// Auth Endpoints
app.post('/api/signup', async (req, res) => {
    const { email, password } = req.body;
    const users = await getUsers();
    if (users.find((u: any) => u.email === email)) return res.status(400).json({ error: 'User exists' });
    
    const newUser = { id: 'user_' + Date.now(), email, password };
    users.push(newUser);
    await saveUsers(users);
    res.json({ id: newUser.id, email: newUser.email });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const users = await getUsers();
    const user = users.find((u: any) => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ id: user.id, email: user.email });
});

app.get('/api/trends', async (req, res) => {
    try {
        // Fetch real-time trending fashion topics (United States)
        const results = await googleTrends.realTimeTrends({ geo: 'US', category: 'f' }); // 'f' is for Health/Fitness? No, 'm' is for Sports, 's' is for Science, 'h' is for Top Stories, 't' is for Tech, 'b' is for Business, 'e' is for Entertainment, 'all' is for all
        // Let's use 'h' or 'all' for general top trends or try searching for specific fashion keywords
        
        // Alternative: Use dailyTrends for better fashion results
        const dailyTrends = await googleTrends.dailyTrends({ geo: 'US' });
        const data = JSON.parse(dailyTrends);
        const trendingItems = data.default.trendingSearchesDays[0].trendingSearches.slice(0, 5);
        
        const trends = trendingItems.map((item: any) => ({
            title: item.title.query,
            source: item.articles[0]?.source || 'Google Trends',
            time: item.articles[0]?.timeAgo || 'Live',
            trend: `+${item.formattedTraffic || '100%'} search volume`,
            url: item.articles[0]?.url || `https://www.google.com/search?q=${encodeURIComponent(item.title.query)}`
        }));
        
        res.json(trends);
    } catch (err) {
        console.error('Failed to fetch Google Trends:', err);
        // Fallback to stylized mock data if the API fails (e.g. rate limits)
        res.json([
            { title: 'Quiet Luxury Dominates SS26', source: 'Vogue Business', time: '2h ago', trend: '+140% search volume' },
            { title: '90s Minimalist Sneakers Are Back', source: 'Hypebeast', time: '5h ago', trend: 'Trending in Paris' },
            { title: 'The Rise of Digital Tailoring', source: 'BoF', time: '1d ago', trend: 'New Market Entry' },
            { title: 'Pastel Chrome: The New Palette', source: 'Trendalytics', time: '2d ago', trend: 'Growing interest' }
        ]);
    }
});

app.get('/', (req, res) => res.send('StyleSense AI Engine is running.'));

// Global AI Setup
const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY!,
    httpOptions: { apiVersion: 'v1beta' }
});

const SYSTEM_INSTRUCTION = `
You are StyleSense AI, a world-class Visual Style Transition Coach.

CRITICAL RESET RULE:
Whenever you receive a message starting with "Update Goal", you MUST COMPLETELY FORGET all previous stylistic goals, keywords, and conversation history regarding older styles. You only care about the NEW goal provided.

UI & COMMUNICATION RULES:
- CONCISE WRITTEN SUMMARY: Your written analysis (via update_style_insights) MUST be a single headline (max 10 words).
- VOCAL ADVICE: Provide your full coaching via AUDIO only. Speak naturally.
- NO INTERNAL MONOLOGUE: NEVER speak about your technical state, your inability to see things, or your "thinking process". Just speak as a confident stylist.
- REASSURANCE: ALWAYS start your vocal response by acknowledging that you see the user or their uploaded look. Say "I see your look..." or "Looking at your outfit...".
- VISION ENABLED: Analyze the outfit and posture. Prioritize uploaded "Current Look" > "Live Feed". 
- TAILORED: Focus EXCLUSIVELY on the current "Target Aesthetic".
`;

const toolsList = [
  { 
    googleSearch: {},
    functionDeclarations: [
      {
        name: 'update_style_insights',
        description: 'Updates the visual summary report.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING, description: 'Short 1-2 sentence overview' },
            top_tip: { type: Type.STRING, description: 'One actionable stylistic tip' },
            vocal_script: { type: Type.STRING, description: 'The full detailed advice to be spoken' }
          },
          required: ['summary', 'top_tip', 'vocal_script']
        }
      },
      {
        name: 'generate_style_batch',
        description: 'Generates a batch of 6 styles with verified images.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            options: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  retailers: { type: Type.ARRAY, items: { type: Type.STRING } },
                  imageUrl: { type: Type.STRING },
                  style_keyword: { type: Type.STRING, description: 'Keywords to find this style on Unsplash if link fails (e.g. "minimalist beige coat")' },
                  shop_url: { type: Type.STRING, description: 'Direct link to Google Shopping results for this item' }
                },
                required: ['name', 'reason', 'retailers', 'imageUrl', 'style_keyword', 'shop_url']
              }
            }
          },
          required: ['options']
        }
      },
      {
        name: 'add_to_closet',
        description: 'Adds item to closet.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            description: { type: Type.STRING },
            imageUrl: { type: Type.STRING },
            retailers: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ['name', 'description', 'imageUrl', 'retailers']
        }
      }
    ]
  }
];

wss.on('connection', async (ws: WebSocket, request) => {
  // Extract userId from URL query params
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const userId = url.searchParams.get('userId');

  if (!userId) {
      console.log('Rejected: No userId provided');
      ws.close();
      return;
  }

  console.log(`--- CLIENT CONNECTED (${userId}) ---`);

  // Load User Data
  let myPreferences = (await loadFromPersistence(userId, 'preferences.json', { preferences: '' })).preferences;
  let myCloset = await loadFromPersistence(userId, 'closet.json', []);
  
  ws.send(JSON.stringify({ toolCallResult: { name: 'get_closet', result: { items: myCloset } } }));

  let session: any;

  // Tool Handlers (now closure-scoped to user)
  const toolHandlers: Record<string, Function> = {
    update_style_insights: async (args: any) => args,
    generate_style_batch: async (args: any) => {
        console.log(`[DEBUG] generate_style_batch for user ${userId} with ${args.options?.length || 0} suggestions.`);
        
        if (!args.options || !Array.isArray(args.options)) {
            console.error("!!! generate_style_batch: Invalid or empty options received.");
            return { suggestions: [] };
        }

        // Parallel processing for faster response
        const suggestions = await Promise.all(args.options.map(async (opt: any, i: number) => {
            let finalUrl = opt.imageUrl;
            const keyword = encodeURIComponent(opt.style_keyword || opt.name || 'fashion');
            
            // If the model didn't provide a shop_url, we generate a Google Shopping link
            const shopUrl = opt.shop_url || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(opt.name)}`;

            const isPlaceholder = !finalUrl || finalUrl.includes('example.com') || finalUrl.length < 15 || !finalUrl.startsWith('http');
            
            console.log(`  [Sugg ${i}] name: ${opt.name}, original_url: ${finalUrl}, isPlaceholder: ${isPlaceholder}`);

            if (isPlaceholder) {
                // Use Pollinations.ai for high-quality, prompt-matched fashion images.
                // This ensures the preview matches the "Shop" keyword (e.g. classic beige trench).
                const prompt = encodeURIComponent(`${opt.style_keyword || opt.name} fashion editorial high quality photography`);
                finalUrl = `https://image.pollinations.ai/prompt/${prompt}?width=800&height=1000&nologo=true&seed=${Math.floor(Math.random() * 1000000)}`;
                console.log(`  [Sugg ${i}] Using Prompt-Matched AI Preview: ${finalUrl}`);
            }
            
            return { ...opt, imageUrl: finalUrl, shop_url: shopUrl };
        }));
        return { suggestions };
    },
    add_to_closet: async (args: any) => {
        const newItem = { id: String(Date.now()), ...args };
        myCloset.push(newItem);
        await saveToPersistence(userId, 'closet.json', myCloset);
        return { success: true, item: newItem };
    }
  };

  try {
    session = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-latest',
      config: {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + (myPreferences ? `\n\nUSER TARGET STYLE PROFILE: ${myPreferences}` : "") }] },
        tools: toolsList,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        responseModalities: [Modality.AUDIO]
      },
      callbacks: {
        onopen: () => {
            console.log(`--- Gemini Connected for ${userId} ---`);
            setTimeout(() => {
                if (session) {
                    session.sendClientContent({ 
                        turns: [{ role: 'user', parts: [{ text: "Coach, show me a visual gallery of 6 real-world style options for my Target Goal." }] }], 
                        turnComplete: true 
                    });
                }
            }, 1000);
        },
        onmessage: async (message: any) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          
          if (message.serverContent?.modelTurn) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.text) ws.send(JSON.stringify({ text: part.text }));
              if (part.inlineData) ws.send(JSON.stringify({ audio: part.inlineData.data }));
            }
          }

          if (message.toolCall) {
            console.log(`[DEBUG] Tool Call received:`, JSON.stringify(message.toolCall, null, 2));
            const functionResponses = [];
            const functionCalls = message.toolCall.functionCalls || [];
            
            for (const call of functionCalls) {
              const toolFunc = toolHandlers[call.name];
              if (toolFunc) {
                try {
                    const result = await toolFunc(call.args);
                    ws.send(JSON.stringify({ toolCallResult: { name: call.name, result } }));
                    functionResponses.push({ id: call.id, name: call.name, response: result });
                } catch (err) {
                    console.error(`Error executing tool ${call.name}:`, err);
                    functionResponses.push({ id: call.id, name: call.name, response: { error: "Execution failed" } });
                }
              }
            }
            if (functionResponses.length > 0) session.sendToolResponse({ functionResponses });
          }
        },
        onerror: (error: any) => {
            console.error('!!! Gemini Error:', JSON.stringify(error, null, 2) || error);
        },
        onclose: (event: any) => {
          console.log(`--- Gemini Closed for ${userId} --- Code: ${event.code}`, event.reason ? `Reason: ${event.reason}` : '');
          if (ws.readyState === WebSocket.OPEN) ws.close();
        }
      }
    });
  } catch (err) {
    console.error("Failed to connect:", err);
    ws.close();
    return;
  }

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.realtimeInput) {
        if (data.realtimeInput.mediaChunks) {
            // Map chunks to the format expected by Multimodal Live API: Part[] with inlineData
            session.sendRealtimeInput(data.realtimeInput.mediaChunks.map((chunk: any) => ({
                inlineData: { mimeType: chunk.mimeType, data: chunk.data }
            })));
        }
      } else if (data.text) {
        // Special case: Update Goal command
        if (data.text.startsWith("Update Goal: ")) {
            myPreferences = data.text.replace("Update Goal: ", "");
            await saveToPersistence(userId, 'preferences.json', { preferences: myPreferences });
            session.sendClientContent({ 
                turns: [{ role: 'user', parts: [{ text: `CRITICAL INSTRUCTION: My Target Aesthetic has been CHANGED to: "${myPreferences}". FORGET all previous goals. Strictly follow this NEW goal. IMMEDIATELY generate a new visual gallery batch of 6 items for this style now.` }] }], 
                turnComplete: true 
            });
        } else {
            session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: data.text }] }], turnComplete: true });
        }
      }
    } catch (e) { console.error('WS Message Error:', e); }
  });

  ws.on('close', () => {
    console.log(`Client disconnected (${userId})`);
    session?.close();
  });
});

app.listen(3001, () => console.log('HTTP Server listening on port 3001'));
console.log(`StyleSense AI Engine listening on port 4002`);
