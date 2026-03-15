import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, Modality } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

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
  
  // Local Fallback with atomic-like write (write to temp file then rename)
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

    // Chain onto the queue to ensure sequential writes
    saveUsersQueue = saveUsersQueue.then(doSave).catch(() => doSave());
    return saveUsersQueue;
}

import { promisify } from 'util';
const scryptAsync = promisify(crypto.scrypt);

// Helper to hash password asynchronously
async function hashPassword(password: string, salt: string) {
    const derivedKey = await scryptAsync(password, salt, 64) as Buffer;
    return derivedKey.toString('hex');
}

// Auth Endpoints
app.post('/api/signup', async (req, res) => {
    try {
        const { email, password, name, sex, basicPreferences } = req.body;
        if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 255) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        if (!password || typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const users = await getUsers();
        if (users.find((u: any) => u.email === email)) return res.status(409).json({ error: 'User exists' });

        // Sanitize optional inputs for length
        const safeName = typeof name === 'string' ? name.substring(0, 100) : '';
        const safeSex = typeof sex === 'string' ? sex.substring(0, 50) : 'unspecified';
        const safePrefs = typeof basicPreferences === 'string' ? basicPreferences.substring(0, 500) : '';

        const salt = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await hashPassword(password, salt);
        const newUser = { id: 'user_' + Date.now(), email, password: hashedPassword, salt, name: safeName, sex: safeSex, basicPreferences: safePrefs };
        users.push(newUser);
        await saveUsers(users);
        res.status(201).json({ id: newUser.id, email: newUser.email, name: newUser.name, sex: newUser.sex, basicPreferences: newUser.basicPreferences });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const users = await getUsers();
        const user = users.find((u: any) => u.email === email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        // Handle old plain-text users gracefully or enforce hashed comparison
        const isMatch = user.salt
            ? user.password === await hashPassword(password, user.salt)
            : user.password === password; // Temporary fallback for existing users without salt

        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
        res.status(200).json({ id: user.id, email: user.email, name: user.name || '', sex: user.sex || 'unspecified', basicPreferences: user.basicPreferences || '' });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/', (req, res) => res.send('StyleSense AI Engine is running.'));

// Global AI Setup
const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY!
});

const SYSTEM_INSTRUCTION = `
You are StyleSense AI, a world-class Visual Style Transition Coach.

CORE RULES:
- VISUAL FOCUS: You must generate real-world style options. If the user asks for a gallery or more items, call 'generate_style_batch' with 5 to 10 items.
- IMAGE SELECTION: Your 'imageUrl' MUST be a high-quality, direct fashion image link that you find via Google Search. Do not use example.com links or placeholder links. The generated image and the 'Shop' description must match perfectly. Find a real product image online.
- GOOGLE SEARCH: Use search to find the latest trends, exact store availability, and real image URLs from Google Shopping, retailers, or fashion blogs.
- ONE SUMMARY: When updating style insights, keep the "improvements" string EXTREMELY SHORT (1 or 2 sentences max) to fit cleanly in the UI. Speak aloud if you need to say more.
- PERSONALIZED: Use the specific user's Style Profile and demographics provided below to tailor all suggestions specifically to them (e.g. if they are male, ONLY suggest men's clothing).
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
        description: 'Generates a batch of styles with verified images to show the user.',
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
  const rawUserId = url.searchParams.get('userId');

  if (!rawUserId) {
      console.log('Rejected: No userId provided');
      ws.close();
      return;
  }

  // Basic validation to prevent arbitrary connections or injection
  const userId = sanitizeId(rawUserId);
  const users = await getUsers();
  const user = users.find((u: any) => u.id === userId);

  if (!user) {
      console.log(`Rejected: Invalid userId connected (${userId})`);
      ws.close();
      return;
  }

  console.log(`--- CLIENT CONNECTED (${userId}) ---`);

  // Load User Data
  let myPreferences = (await loadFromPersistence(userId, 'preferences.json', { preferences: '' })).preferences;
  let myCloset = await loadFromPersistence(userId, 'closet.json', []);
  
  // Find User Demographic
  const userName = user.name || '';
  const userSex = user.sex || 'unspecified';
  const userBasicPreferences = user.basicPreferences || '';

  ws.send(JSON.stringify({ toolCallResult: { name: 'get_closet', result: { items: myCloset } } }));

  let session: any;

  // Tool Handlers (now closure-scoped to user)
  const toolHandlers: Record<string, Function> = {
    update_style_insights: async (args: any) => args,
    generate_style_batch: async (args: any) => {
        // Return exactly what the AI generated, trusting it to provide valid image URLs from Google Search.
        // If the AI fails to find an image, we still want to show what it *thought* it found, rather than
        // hardcoding static Unsplash placeholders that cause a mismatch between visual and description.
        const suggestions = args.options.map((opt: any) => {
            // As a last-resort fallback to prevent broken images entirely if AI really hallucinates a bad URL:
            let finalUrl = opt.imageUrl;
            if (!finalUrl || finalUrl.includes('example.com') || !finalUrl.startsWith('http')) {
                // We use a generic placeholder service that echoes back the description text as an image,
                // so the user knows what should be there, rather than a completely unrelated fashion image.
                finalUrl = `https://placehold.co/600x800/222222/FFFFFF/png?text=${encodeURIComponent(opt.name)}`;
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
    const contextPrompt =
      (userName ? `\n\nUSER NAME: ${userName}` : "") +
      (userSex !== 'unspecified' ? `\n\nUSER SEX/GENDER: ${userSex}` : "") +
      (userBasicPreferences ? `\n\nUSER BASIC PREFERENCES: ${userBasicPreferences}` : "") +
      (myPreferences ? `\n\nCURRENT SESSION STYLE TARGET: ${myPreferences}` : "");

    session = await ai.live.connect({
      model: 'gemini-2.0-flash-exp',
      config: {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + contextPrompt }] },
        tools: toolsList
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
            // Let the coach know the focus changed without necessarily needing a generic user message
            session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `System Note: The user just changed their current Style Session focus to: ${myPreferences}` }] }], turnComplete: true });
            return;
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
