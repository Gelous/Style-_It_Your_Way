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

app.get('/', (req, res) => res.send('StyleSense AI Engine is running.'));

// Global AI Setup
const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY!
});

const SYSTEM_INSTRUCTION = `
You are StyleSense AI, a world-class Visual Style Transition Coach.

UI & COMMUNICATION RULES:
- CONCISE WRITTEN SUMMARY: Your written analysis (via update_style_insights) MUST be a single, punchy paragraph (max 2 sentences).
- VOCAL ADVICE: Provide your full, detailed coaching and stylistic reasoning via AUDIO only.
- VISION ENABLED: Analyze the user's current outfit and posture.
- GOOGLE SEARCH MANDATORY: For EVERY style suggestion, use 'googleSearch' to find:
  1. REAL product images (look for direct .jpg/.png links in the search results).
  2. Direct merchant shop links.
- VISUAL FOCUS: Provide 6 real-world options using 'generate_style_batch'.
- IMAGE QUALITY: If you cannot find a direct link, leave 'imageUrl' empty and provide a 'style_keyword'. 
- PERSONALIZED: Focus on the user's "Target Aesthetic" provided below.
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
          
          console.log(`[RAW MESSAGE]`, JSON.stringify(message).substring(0, 500)); // Log first 500 chars of raw message
          
          if (message.groundingMetadata) {
            console.log(`[DEBUG] Grounding Metadata:`, JSON.stringify(message.groundingMetadata, null, 2));
          }

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
        if (data.realtimeInput.audio) {
            session.sendRealtimeInput({ audio: data.realtimeInput.audio });
        } else if (data.realtimeInput.video) {
            session.sendRealtimeInput({ video: data.realtimeInput.video });
        } else if (data.realtimeInput.mediaChunks) {
            for (const chunk of data.realtimeInput.mediaChunks) {
                if (chunk.mimeType.includes('audio')) session.sendRealtimeInput({ audio: chunk });
                else session.sendRealtimeInput({ video: chunk });
            }
        }
      } else if (data.text) {
        // Special case: Update Goal command
        if (data.text.startsWith("Update Goal: ")) {
            myPreferences = data.text.replace("Update Goal: ", "");
            await saveToPersistence(userId, 'preferences.json', { preferences: myPreferences });
            session.sendClientContent({ 
                turns: [{ role: 'user', parts: [{ text: `CRITICAL INSTRUCTION: My Target Aesthetic has been CHANGED to: "${myPreferences}". FORGET all previous goals. Strictly follow this NEW goal for all future recommendations and visual gallery updates. Acknowledge this change now and update your style batch immediately.` }] }], 
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
