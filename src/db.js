import mongoose from 'mongoose';

const DEFAULT_OPTIONS = {
  maxPoolSize: 50,
  waitQueueTimeoutMS: 5000,
  bufferCommands: false,
  autoIndex: false
};

export async function connectDB(uri) {
  if (mongoose.connection.readyState >= 1) {
    console.log('✅ MongoDB already connected (reused connection)');
    return mongoose.connection;
  }

  if (!globalThis.__mongooseConnection) {
    globalThis.__mongooseConnection = mongoose.connect(uri, {
      ...DEFAULT_OPTIONS,
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
  }

  await globalThis.__mongooseConnection;
  console.log('✅ MongoDB connected');
  return mongoose.connection;
}

const SkinSchema = new mongoose.Schema(
  {
    id: String,
    result_id: { type: String, index: true },
    title: String,
    image: String,
    url: { type: String, index: true },
    sourceId: { type: String, index: true }, // use if API returns a stable id
    hashedKey: { type: String, unique: true }, // idempotency key
    customerInfo: String,
    gender: String,
    deviceNumber: String,
    account: String,
    testTime: { type: String, index: true },
    crt_time: { type: String, index: true },
    testStatus: String,
    remarks: String,
    scrapedAt: { type: Date, default: Date.now }
  },
  { timestamps: true, strict: false }
);

// Create an idempotency key from the most stable fields
SkinSchema.statics.keyFor = function (doc) {
  const raw = `${doc.sourceId || ''}|${doc.url || ''}|${doc.title || ''}|${doc.image || ''}`;
  return Buffer.from(raw).toString('base64');
};

export const Skin = mongoose.model('Skin', SkinSchema);

const SyncStateSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, index: true },
    rangeStart: { type: String, default: null },
    rangeEnd: { type: String, default: null },
    status: { type: String, default: 'idle' }, // idle|queued|running|success|error
    lastRequestedAt: { type: Date, default: null },
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    totalRecords: { type: Number, default: 0 },
    upserts: { type: Number, default: 0 },
    newCount: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    unchangedCount: { type: Number, default: 0 },
    incremental: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const SyncState = mongoose.model('SyncState', SyncStateSchema);
