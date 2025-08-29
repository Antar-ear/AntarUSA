// server.js — Azure MVP (Antar USA)
// ----------------------------------------------------
const express   = require('express');
const http      = require('http');
const path      = require('path');
const cors      = require('cors');
const helmet    = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');
require('dotenv').config();

// Azure helpers (you already added these files)
const { transcribeOnce } = require('./speech/azure_speech');
const { translateText }  = require('./speech/azure_translate');

// ----------------------------------------------------
// App & server
// ----------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.set('trust proxy', true); // Render/Heroku proxy → correct https + IPs
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false })); // simple CSP off for Socket.IO scripts
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// In-memory room/user state
// ----------------------------------------------------
/**
 * activeRooms: Map<roomId, {
 *   hotelName: string,
 *   createdAt: Date,
 *   users: Set<socketId>,
 *   guestLanguage: string | null
 * }>
 */
const activeRooms = new Map();

/**
 * userRoles: Map<socketId, { room: string, role: 'guest'|'receptionist'|'admin', language: string }>
 */
const userRoles = new Map();

// Display helper for languages
const languageNames = {
  'hi-IN': 'Hindi',
  'bn-IN': 'Bengali',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'mr-IN': 'Marathi',
  'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'pa-IN': 'Punjabi',
  'or-IN': 'Odia',
  'od-IN': 'Odia', // alias
  'en-US': 'English',
  'en-IN': 'English',
  'es-ES': 'Spanish',
  'de-DE': 'German',
  'fr-FR': 'French'
};

function getGuestLanguageInRoom(room) {
  const roomData = activeRooms.get(room);
  return roomData?.guestLanguage || 'hi-IN'; // default guest language
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', async (req, res) => {
  const azureSpeechConfigured = Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  const azureTranslatorConfigured = Boolean(process.env.AZURE_TRANSLATOR_KEY && process.env.AZURE_TRANSLATOR_REGION);

  // Fast, non-billing health; we only check presence of env keys.
  // (If you want a deep check, you could call translateText('ping','en-US','hi-IN') with a short timeout.)
  res.json({
    status: (azureSpeechConfigured && azureTranslatorConfigured) ? 'ok' : 'degraded',
    azureSpeech: azureSpeechConfigured,
    azureTranslator: azureTranslatorConfigured,
    timestamp: new Date().toISOString()
  });
});

// Create room (client builds QR URL via location.origin)
app.post('/api/generate-room', (req, res) => {
  const { hotelName } = req.body || {};
  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  activeRooms.set(roomId, {
    hotelName: hotelName || 'Unknown Hotel',
    createdAt: new Date(),
    users: new Set(),
    guestLanguage: null
  });

  // You can also return a server-built URL if you want:
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const baseUrl = `${proto}://${req.get('host')}`;
  const guestUrl = `${baseUrl}/?room=${roomId}`;

  return res.json({ roomId, guestUrl, qrData: guestUrl });
});

// MVP: TTS disabled — return 501 so UI keeps buttons disabled
app.post('/api/tts', (_req, res) => {
  return res.status(501).json({ error: 'TTS disabled in MVP. Enable Azure Speech Synthesis later.' });
});

// ----------------------------------------------------
// Socket.IO
// ----------------------------------------------------
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('join_room', (data = {}) => {
    try {
      const { room, role, language } = data;
      if (!room || !role) {
        return socket.emit('error', { message: 'Missing room/role' });
      }

      // leave previous
      const prev = userRoles.get(socket.id)?.room;
      if (prev) {
        socket.leave(prev);
        const pr = activeRooms.get(prev);
        if (pr) pr.users.delete(socket.id);
      }

      // join new
      if (!activeRooms.has(room)) {
        activeRooms.set(room, {
          hotelName: 'Unknown Hotel',
          createdAt: new Date(),
          users: new Set(),
          guestLanguage: null
        });
      }

      socket.join(room);
      const lang = role === 'receptionist' ? (language || 'en-US') : (language || 'hi-IN');
      userRoles.set(socket.id, { room, role, language: lang });

      const roomData = activeRooms.get(room);
      roomData.users.add(socket.id);

      // Track guest language at room level
      if (role === 'guest') {
        roomData.guestLanguage = lang;
      }

      console.log(`User ${socket.id} joined ${room} as ${role} (${lang})`);
      socket.emit('room_joined', { room, role, language: languageNames[lang] || lang });

      // broadcast stats
      io.to(room).emit('room_stats', {
        userCount: roomData.users.size,
        hotelName: roomData.hotelName,
        guestLanguage: roomData.guestLanguage
      });

      // notify others
      socket.to(room).emit('user_joined', {
        role,
        language: languageNames[lang] || lang,
        userId: socket.id
      });
    } catch (err) {
      console.error('join_room error:', err);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('audio_message', async (data = {}) => {
    try {
      const { room, role, language, audioData } = data;
      const userInfo = userRoles.get(socket.id);
      if (!userInfo || userInfo.room !== room) {
        return socket.emit('error', { message: 'Not authorized for this room' });
      }

      io.to(room).emit('processing_status', { status: 'transcribing', speaker: role });

      // Decode base64 PCM16 LE 16k
      const audioBuffer = Buffer.from(audioData || '', 'base64');

      // 1) STT (from source language)
      const sttLang = (role === 'guest') ? (language || userInfo.language) : 'en-US';
      const stt = await transcribeOnce(audioBuffer, sttLang);
      const transcript = (stt.transcript || '').trim();

      if (!transcript) {
        io.to(room).emit('processing_status', { status: 'error', message: 'No speech detected' });
        return;
      }

      io.to(room).emit('processing_status', { status: 'translating', speaker: role });

      // 2) Translate
      let sourceLanguage, targetLanguage;
      if (role === 'guest') {
        sourceLanguage = sttLang; // guest’s language
        targetLanguage = 'en-US';
      } else {
        sourceLanguage = 'en-US';
        targetLanguage = getGuestLanguageInRoom(room);
      }

      const tr = await translateText(transcript, sourceLanguage, targetLanguage);
      const translated = tr.text || '';

      // 3) Emit to room
      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        room,
        speaker: role,
        original: {
          text: transcript,
          language: sourceLanguage,
          languageName: languageNames[sourceLanguage] || sourceLanguage
        },
        translated: {
          text: translated,
          language: targetLanguage,
          languageName: languageNames[targetLanguage] || targetLanguage
        },
        confidence: stt.confidence || 0.95,
        speakerId: socket.id,
        ttsAvailable: false // MVP
      };

      io.to(room).emit('translation', messageData);
      io.to(room).emit('processing_status', { status: 'complete' });
    } catch (err) {
      console.error('audio_message error:', err?.message || err);
      socket.emit('error', { message: 'Failed to process audio message', error: String(err?.message || err) });
      const room = userRoles.get(socket.id)?.room;
      if (room) io.to(room).emit('processing_status', { status: 'error', message: String(err?.message || err) });
    }
  });

  socket.on('text_message', async (data = {}) => {
    try {
      const { room, role, language, text } = data;
      const userInfo = userRoles.get(socket.id);
      if (!userInfo || userInfo.room !== room) {
        return socket.emit('error', { message: 'Not authorized for this room' });
      }

      io.to(room).emit('processing_status', { status: 'translating', speaker: role });

      let sourceLanguage, targetLanguage;
      if (role === 'guest') {
        sourceLanguage = language || userInfo.language;
        targetLanguage = 'en-US';
      } else {
        sourceLanguage = 'en-US';
        targetLanguage = getGuestLanguageInRoom(room);
      }

      const tr = await translateText(text, sourceLanguage, targetLanguage);
      const translated = tr.text || '';

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        room,
        speaker: role,
        original: {
          text: text,
          language: sourceLanguage,
          languageName: languageNames[sourceLanguage] || sourceLanguage
        },
        translated: {
          text: translated,
          language: targetLanguage,
          languageName: languageNames[targetLanguage] || targetLanguage
        },
        confidence: 1.0,
        speakerId: socket.id,
        ttsAvailable: false
      };

      io.to(room).emit('translation', messageData);
      io.to(room).emit('processing_status', { status: 'complete' });
    } catch (err) {
      console.error('text_message error:', err?.message || err);
      socket.emit('error', { message: 'Failed to process text message', error: String(err?.message || err) });
      const room = userRoles.get(socket.id)?.room;
      if (room) io.to(room).emit('processing_status', { status: 'error', message: String(err?.message || err) });
    }
  });

  socket.on('get_room_info', (data = {}) => {
    const roomInfo = activeRooms.get(data.room);
    if (roomInfo) {
      socket.emit('room_info', {
        hotelName: roomInfo.hotelName,
        userCount: roomInfo.users.size,
        createdAt: roomInfo.createdAt,
        guestLanguage: roomInfo.guestLanguage
      });
    }
  });

  socket.on('disconnect', () => {
    const info = userRoles.get(socket.id);
    if (info) {
      const { room, role } = info;
      const r = activeRooms.get(room);
      if (r) {
        r.users.delete(socket.id);
        if (role === 'guest') r.guestLanguage = null;

        socket.to(room).emit('user_left', { role, userId: socket.id });
        io.to(room).emit('room_stats', {
          userCount: r.users.size,
          hotelName: r.hotelName,
          guestLanguage: r.guestLanguage
        });

        // Clean empty rooms after 5 minutes
        if (r.users.size === 0) {
          setTimeout(() => {
            const rr = activeRooms.get(room);
            if (rr && rr.users.size === 0) {
              activeRooms.delete(room);
              console.log(`Cleaned empty room: ${room}`);
            }
          }, 5 * 60 * 1000);
        }
      }
      userRoles.delete(socket.id);
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
});

// ----------------------------------------------------
// Errors
// ----------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ----------------------------------------------------
// Start
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Hotel Translation (Azure MVP) running on :${PORT}`);
  console.log(`Open http://localhost:${PORT} for the UI`);
  if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
    console.warn('⚠️  Missing AZURE_SPEECH_* env vars — STT will fail');
  }
  if (!process.env.AZURE_TRANSLATOR_KEY || !process.env.AZURE_TRANSLATOR_REGION) {
    console.warn('⚠️  Missing AZURE_TRANSLATOR_* env vars — translation will fail');
  }
});

module.exports = { app, server, io };

