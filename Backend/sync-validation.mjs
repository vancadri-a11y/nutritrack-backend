const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = {
  profile: ['id','name','weightKG','heightCM','age','goal','activity','reference','createdAt','nutritionPlanData','workoutLocation','photoSchema','photoPath'],
  meal: ['id','recordedAt','title','calories','protein','carbs','fat','confidence','notes','isDemo','mealType','origin','assetName','photoSchema','photoPath'],
  preferences: ['id','settingsSchema','preferencesData'],
  water: ['id','recordedAt','milliliters'],
  workout: ['id','title','createdAt','goal','sessionsData'],
  log: ['id','completionKey','completedAt','title','minutes']
};
export function validateSyncChanges(data) {
  if (!data || Object.keys(data).some(k => k !== 'items') || !Array.isArray(data.items) || data.items.length > 50) throw new Error('Invalid sync batch');
  const keys = new Set();
  for (const item of data.items) {
    if (!item || Object.keys(item).some(k => !['key','base_version','deleted','payload'].includes(k)) ||
        typeof item.key !== 'string' || keys.has(item.key) || !Number.isSafeInteger(item.base_version) || item.base_version < 0 ||
        typeof item.deleted !== 'boolean') throw new Error('Invalid sync record');
    keys.add(item.key);
    const kind = item.key.split(':')[0];
    if (!(item.key === 'profile' || item.key === 'preferences' || (!['profile','preferences'].includes(kind) && fields[kind] && uuid.test(item.key.slice(kind.length + 1))))) throw new Error('Invalid key');
    if (item.deleted) { if (item.payload !== null) throw new Error('Invalid tombstone'); continue; }
    const p = item.payload;
    if (!p || Array.isArray(p) || typeof p !== 'object' || !uuid.test(p.id || '') ||
      (!['profile','preferences'].includes(kind) && item.key.toLowerCase() !== `${kind}:${p.id}`.toLowerCase()) ||
      Object.keys(p).some(k => !fields[kind].includes(k)) || Buffer.byteLength(JSON.stringify(p)) > 100000) throw new Error('Invalid payload');
    for (const [key, value] of Object.entries(p)) {
      if (typeof value === 'string' && value.length > (key.endsWith('Data') ? 80000 : 4000)) throw new Error('Text too large');
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1e12)) throw new Error('Invalid value');
      if (value !== null && !['string','boolean','number'].includes(typeof value)) throw new Error('Invalid field');
    }
    if (kind === 'profile' && (typeof p.name !== 'string' || !p.name.trim() || p.age < 1 || p.age > 120 || p.weightKG < 1 || p.weightKG > 700 || p.heightCM < 30 || p.heightCM > 300)) throw new Error('Invalid profile');
    if (kind === 'water' && (!Number.isInteger(p.milliliters) || p.milliliters < 1 || p.milliliters > 10000)) throw new Error('Invalid water');
    if (['meal','workout','log'].includes(kind) && typeof p.title !== 'string') throw new Error('Invalid title');
    if ('photoSchema' in p) {
      if (p.photoSchema !== 1 || (p.photoPath != null && (typeof p.photoPath !== 'string' ||
        !new RegExp(`^${kind}/${p.id.toLowerCase()}/[0-9a-f]{64}\\.jpg$`).test(p.photoPath)))) throw new Error('Invalid photo reference');
    } else if ('photoPath' in p) throw new Error('Missing photo schema');
    if (kind === 'preferences') {
      if (p.settingsSchema !== 1 || typeof p.preferencesData !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.preferencesData)) throw new Error('Invalid preferences');
      let settings;
      try { settings = JSON.parse(Buffer.from(p.preferencesData,'base64').toString('utf8')); } catch { throw new Error('Invalid preferences'); }
      if (!settings || Array.isArray(settings) || typeof settings !== 'object' || JSON.stringify(settings).length > 50000 ||
        Object.keys(settings).some(k=>!['theme','accent','onlinePhotos','waterGoal','favorites','symbols','workoutProgress','reminderEnabled','reminderHours'].includes(k)) ||
        !['system','light','dark'].includes(settings.theme) || typeof settings.accent !== 'string' ||
        typeof settings.onlinePhotos !== 'boolean' || !Number.isInteger(settings.waterGoal) || settings.waterGoal<500 || settings.waterGoal>4000 ||
        !Array.isArray(settings.favorites) || settings.favorites.length>1000 || settings.favorites.some(x=>typeof x!=='string'||x.length>100) ||
        !settings.symbols || Array.isArray(settings.symbols) || typeof settings.symbols!=='object' || Object.keys(settings.symbols).length>20 || Object.values(settings.symbols).some(x=>typeof x!=='string'||x.length>100) ||
        !settings.workoutProgress || Array.isArray(settings.workoutProgress) || typeof settings.workoutProgress!=='object' || Object.keys(settings.workoutProgress).length>365 ||
        Object.entries(settings.workoutProgress).some(([k,v])=>k.length>200||!Array.isArray(v)||v.length>100||v.some(x=>!Number.isInteger(x)||x<0||x>1000)) ||
        typeof settings.reminderEnabled!=='boolean' || !Array.isArray(settings.reminderHours) || settings.reminderHours.length!==4 || settings.reminderHours.some(x=>!Number.isInteger(x)||x<0||x>23)) throw new Error('Invalid preferences');
    }
  }
  return data.items;
}
