import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ port: 4002 });

// Persistence Configuration
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'siyw';
let storage: Storage | null = null;
try {
  // Only initialize Storage if the service account credentials exist in the environment
  // This prevents the loud GoogleAuth crash loop on local machines
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    storage = new Storage();
  }
} catch (e) {}

// Helper to sanitize userId against path traversal
function sanitizeId(id: string) {
    return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Helper to save data (Scoped by User)
async function saveToPersistence(userId: string, fileName: string, data: any) {
  const safeUserId = sanitizeId(userId);
  const cloudPath = `${safeUserId}/${fileName}`;
  try {
    if (storage) {
        await storage.bucket(BUCKET_NAME).file(cloudPath).save(JSON.stringify(data, null, 2));
        return;
    }
  } catch (err) {
      console.warn(`Failed to save to GCS bucket ${BUCKET_NAME}:`, err);
  }
  
  // Local Fallback with atomic-like write
  try {
      const userDir = path.join(process.cwd(), 'data', safeUserId);
      await fs.mkdir(userDir, { recursive: true });
      const tempFile = path.join(userDir, `${fileName}.tmp`);
      const targetFile = path.join(userDir, fileName);
      await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
      await fs.rename(tempFile, targetFile);
  } catch (err) {
      console.error('Failed local fallback saveToPersistence:', err);
  }
}

// Helper to load data (Scoped by User)
async function loadFromPersistence(userId: string, fileName: string, defaultValue: any) {
  const safeUserId = sanitizeId(userId);
  const cloudPath = `${safeUserId}/${fileName}`;
  try {
    if (storage) {
        const [exists] = await storage.bucket(BUCKET_NAME).file(cloudPath).exists();
        if (exists) {
            const [content] = await storage.bucket(BUCKET_NAME).file(cloudPath).download();
            return JSON.parse(content.toString());
        }
    }
  } catch (err) {
      console.warn(`Failed to load from GCS bucket ${BUCKET_NAME}:`, err);
  }

  // Local Fallback
  const localPath = path.join(process.cwd(), 'data', safeUserId, fileName);
  try {
    const content = await fs.readFile(localPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) { return defaultValue; }
}

// User Database (Local JSON) - Queue based concurrent protection
const USERS_FILE = path.join(process.cwd(), 'local_users.json');
let saveUsersQueue: Promise<void> = Promise.resolve();

async function getUsers() {
    try {
        const content = await fs.readFile(USERS_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (e) { return []; }
}

async function saveUsers(users: any[]) {
    const doSave = async () => {
        try {
            const tempFile = `${USERS_FILE}.tmp`;
            await fs.writeFile(tempFile, JSON.stringify(users, null, 2));
            await fs.rename(tempFile, USERS_FILE);
        } catch (err) {
            console.error('Failed to save users:', err);
        }
    };
    saveUsersQueue = saveUsersQueue.then(doSave).catch(() => doSave());
    return saveUsersQueue;
}

// Helper to hash password
async function hashPassword(password: string, salt: string) {
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    return derivedKey.toString('hex');
}

// Auth Endpoints
app.post('/api/signup', async (req, res) => {
    try {
        const { email, password, name, sex, basicPreferences } = req.body;
        if (!email || typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
        if (!password || typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Min 8 chars password' });

        const users = await getUsers();
        if (users.find((u: any) => u.email === email)) return res.status(409).json({ error: 'User exists' });

        const salt = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await hashPassword(password, salt);
        const newUser = { id: 'user_' + Date.now(), email, password: hashedPassword, salt, name, sex, basicPreferences };
        users.push(newUser);
        await saveUsers(users);
        res.status(201).json({ id: newUser.id, email: newUser.email, name: newUser.name, sex: newUser.sex, basicPreferences: newUser.basicPreferences });
    } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const users = await getUsers();
        const user = users.find((u: any) => u.email === email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const isMatch = user.salt ? (user.password === await hashPassword(password, user.salt)) : (user.password === password);
        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ id: user.id, email: user.email, name: user.name || '', sex: user.sex || 'unspecified', basicPreferences: user.basicPreferences || '' });
    } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/', (req, res) => res.send('StyleSense AI Engine is running.'));

// Global AI Setup
const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY!
});

const SYSTEM_INSTRUCTION = `
You are StyleSense AI, a world-class Visual Style Transition Coach.

UI & COMMUNICATION RULES:
- CONCISE WRITTEN SUMMARY: Your written analysis MUST be a single, punchy paragraph (max 2 sentences).
- VOCAL ADVICE: Provide your full, detailed coaching and stylistic reasoning via AUDIO only.
- VISION ENABLED: Analyze the user's current outfit and posture.
- GOOGLE SEARCH MANDATORY: For EVERY style suggestion, use 'googleSearch' to find REAL product images and direct store links.
- VISUAL FOCUS: Provide 6 real-world options using 'generate_style_batch'.
- PERSONALIZED: Use the user's demographics (Name, Sex, Preferences) and current Target Aesthetic below to tailor all suggestions.
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
                  style_keyword: { type: Type.STRING },
                  shop_url: { type: Type.STRING }
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
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const rawUserId = url.searchParams.get('userId');
  if (!rawUserId) { ws.close(); return; }

  const userId = sanitizeId(rawUserId);
  const users = await getUsers();
  const user = users.find((u: any) => u.id === userId);
  if (!user) { ws.close(); return; }

  console.log(`--- CLIENT CONNECTED (${userId}) ---`);

  let myPreferences = (await loadFromPersistence(userId, 'preferences.json', { preferences: '' })).preferences;
  let myCloset = await loadFromPersistence(userId, 'closet.json', []);
  
  const contextPrompt =
    `USER NAME: ${user.name || 'User'}\nUSER SEX: ${user.sex || 'unspecified'}\nUSER BASIC PREFS: ${user.basicPreferences || ''}\n` +
    (myPreferences ? `\nCURRENT SESSION STYLE TARGET: ${myPreferences}` : "");

  ws.send(JSON.stringify({ toolCallResult: { name: 'get_closet', result: { items: myCloset } } }));

  let session: any;

  const toolHandlers: Record<string, Function> = {
    update_style_insights: async (args: any) => args,
    generate_style_batch: async (args: any) => {
        if (!args.options || !Array.isArray(args.options)) return { suggestions: [] };
        const suggestions = await Promise.all(args.options.map(async (opt: any, i: number) => {
            let finalUrl = opt.imageUrl;
            const shopUrl = opt.shop_url || `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(opt.name)}`;
            const isPlaceholder = !finalUrl || finalUrl.includes('example.com') || finalUrl.length < 15 || !finalUrl.startsWith('http');
            if (isPlaceholder) {
                const prompt = encodeURIComponent(`Professional e-commerce product photography of ${opt.style_keyword || opt.name} on clean white background`);
                finalUrl = `https://image.pollinations.ai/prompt/${prompt}?width=800&height=1000&nologo=true&seed=${Math.floor(Math.random() * 1000000)}`;
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
      model: 'gemini-2.0-flash-exp',
      config: {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + "\n\n" + contextPrompt }] },
        tools: toolsList,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        responseModalities: ['AUDIO']
      },
      callbacks: {
        onopen: () => {
            console.log(`--- Gemini Connected for ${userId} ---`);
            setTimeout(() => {
                if (session) {
                    session.sendClientContent({ 
                        turns: [{ role: 'user', parts: [{ text: "Coach, please analyze my look and update the style gallery." }] }], 
                      main
                        turnComplete: true 
                    });
                }
            }, 2000);
        },
        onmessage: async (message: any) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          main
          if (message.serverContent?.modelTurn) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.text) ws.send(JSON.stringify({ text: part.text }));
              if (part.inlineData) ws.send(JSON.stringify({ audio: part.inlineData.data }));
            }
          }

          if (message.toolCall) {
            const functionResponses = [];
            for (const call of (message.toolCall.functionCalls || [])) {
              const toolFunc = toolHandlers[call.name];
              if (toolFunc) {
                try {
                    const result = await toolFunc(call.args);
                    ws.send(JSON.stringify({ toolCallResult: { name: call.name, result } }));
                    functionResponses.push({ id: call.id, name: call.name, response: result });
                } catch (err) { functionResponses.push({ id: call.id, name: call.name, response: { error: "failed" } }); }
              }
            }
            if (functionResponses.length > 0) session.sendToolResponse({ functionResponses });
          }
        },
        onerror: (error: any) => { console.error('!!! Gemini Error:', JSON.stringify(error, null, 2)); },
        onclose: (event: any) => {
          console.log(`--- Gemini Closed for ${userId} --- Code: ${event.code}`);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        }
      }
    });
  } catch (err) { console.error("Failed to connect:", err); ws.close(); return; }

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.realtimeInput) {
        // Fallback to original working format or whatever frontend sends
        if (data.realtimeInput.mediaChunks) {
            for (const chunk of data.realtimeInput.mediaChunks) {
                if (chunk.mimeType.includes('audio')) session.sendRealtimeInput({ audio: { data: chunk.data, mimeType: chunk.mimeType } });
                else session.sendRealtimeInput({ media: { data: chunk.data, mimeType: chunk.mimeType } });
            }
        }
origin/fix/security-and-robustness-2686056288197952117
      } else if (data.text) {
        if (data.text.startsWith("Update Goal: ")) {
            myPreferences = data.text.replace("Update Goal: ", "");
            await saveToPersistence(userId, 'preferences.json', { preferences: myPreferences });
            session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: `CRITICAL: My Target Aesthetic is now: "${myPreferences}". Forget previous goals and update gallery.` }] }],
                turnComplete: true
            });
        } else { session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: data.text }] }], turnComplete: true }); }
      }
    } catch (e) { console.error('WS Message Error:', e); }
  });

  ws.on('close', () => { session?.close(); });
});

app.listen(3001, () => console.log('HTTP Server listening on port 3001'));
console.log(`StyleSense AI Engine listening on port 4002`);
