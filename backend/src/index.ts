import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
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

// Helper to save data (Scoped by User)
async function saveToPersistence(userId: string, fileName: string, data: any) {
  const cloudPath = `${userId}/${fileName}`;
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
      const userDir = path.join(process.cwd(), 'data', userId);
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
  const cloudPath = `${userId}/${fileName}`;
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
  const localPath = path.join(process.cwd(), 'data', userId, fileName);
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
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const users = await getUsers();
        if (users.find((u: any) => u.email === email)) return res.status(409).json({ error: 'User exists' });

        const salt = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await hashPassword(password, salt);
        const newUser = { id: 'user_' + Date.now(), email, password: hashedPassword, salt };
        users.push(newUser);
        await saveUsers(users);
        res.status(201).json({ id: newUser.id, email: newUser.email });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const users = await getUsers();
        const user = users.find((u: any) => u.email === email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        // Handle old plain-text users gracefully or enforce hashed comparison
        const isMatch = user.salt
            ? user.password === await hashPassword(password, user.salt)
            : user.password === password; // Temporary fallback for existing users without salt

        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
        res.status(200).json({ id: user.id, email: user.email });
    } catch (e) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/', (req, res) => res.send('StyleSense AI Engine is running.'));

// Global AI Setup
const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY,
    httpOptions: { apiVersion: 'v1beta' }
});

const SYSTEM_INSTRUCTION = `
You are StyleSense AI, a world-class Visual Style Transition Coach.

CORE RULES:
- VISUAL FOCUS: You must provide 6 real-world style options.
- IMAGE SELECTION: Your 'imageUrl' MUST be a high-quality, direct fashion image link that you find via Google Search. Do not use example.com links or placeholder links. The generated image and the 'Shop' description must match perfectly. Find a real product image online.
- GOOGLE SEARCH: Use search to find the latest trends, exact store availability, and real image URLs (e.g. from retailers, Pinterest, Instagram public posts, or fashion blogs).
- ONE SUMMARY: provide a single high-level advice report.
- PERSONALIZED: Use the specific user's Style Profile provided below.
`;

const toolsList = [
  { googleSearch: {} },
  {
    functionDeclarations: [
      {
        name: 'update_style_insights',
        description: 'Updates the summary report.',
        parameters: {
          type: 'OBJECT',
          properties: {
            suggestions: { type: 'STRING' },
            improvements: { type: 'STRING' },
            recommendations: { type: 'STRING' }
          },
          required: ['suggestions', 'improvements', 'recommendations']
        }
      },
      {
        name: 'generate_style_batch',
        description: 'Generates a batch of 6 styles with verified images.',
        parameters: {
          type: 'OBJECT',
          properties: {
            options: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  reason: { type: 'STRING' },
                  retailers: { type: 'ARRAY', items: { type: 'STRING' } },
                  imageUrl: { type: 'STRING' }
                },
                required: ['name', 'reason', 'retailers', 'imageUrl']
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
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            description: { type: 'STRING' },
            imageUrl: { type: 'STRING' },
            retailers: { type: 'ARRAY', items: { type: 'STRING' } }
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
            }
            return { ...opt, imageUrl: finalUrl };
        });
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
      model: 'models/gemini-2.0-flash-exp',
      config: {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + (myPreferences ? `\n\nUSER TARGET STYLE PROFILE: ${myPreferences}` : "") }] },
        tools: toolsList,
        generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } },
        responseModalities: ['AUDIO']
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
            const functionResponses = [];
            for (const call of message.toolCall.functionCalls) {
              const toolFunc = toolHandlers[call.name];
              if (toolFunc) {
                const result = await toolFunc(call.args);
                ws.send(JSON.stringify({ toolCallResult: { name: call.name, result } }));
                functionResponses.push({ id: call.id, name: call.name, response: result });
              }
            }
            if (functionResponses.length > 0) session.sendToolResponse({ functionResponses });
          }
        },
        onerror: (error: any) => console.error('!!! Gemini Error:', error),
        onclose: (event: any) => {
          console.log(`--- Gemini Closed for ${userId} --- Code:`, event.code);
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
        for (const chunk of data.realtimeInput.mediaChunks) {
            if (chunk.mimeType.includes('audio')) session.sendRealtimeInput({ audio: { data: chunk.data, mimeType: chunk.mimeType } });
            else session.sendRealtimeInput({ media: { data: chunk.data, mimeType: chunk.mimeType } });
        }
      } else if (data.text) {
        // Special case: Update Goal command
        if (data.text.startsWith("Update Goal: ")) {
            myPreferences = data.text.replace("Update Goal: ", "");
            await saveToPersistence(userId, 'preferences.json', { preferences: myPreferences });
        }
        session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: data.text }] }], turnComplete: true });
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
