/**
 * TARANG UI translations.
 *
 * Five languages covering the Bay of Bengal coastal states INCOIS primarily serves:
 * English (default/fallback), Hindi, Bengali, Telugu, Tamil. Scientific variable names
 * (thetao, so, …), dataset/attribution text, and dev-facing ids are deliberately left
 * untranslated — only researcher/public-facing UI copy is covered (§ Multilingual UI).
 */

export type LanguageCode = 'en' | 'hi' | 'bn' | 'te' | 'ta'

export const LANGUAGES: { code: LanguageCode; label: string; nativeLabel: string }[] = [
  { code: 'en', label: 'English',  nativeLabel: 'English' },
  { code: 'hi', label: 'Hindi',    nativeLabel: 'हिन्दी' },
  { code: 'bn', label: 'Bengali',  nativeLabel: 'বাংলা' },
  { code: 'te', label: 'Telugu',   nativeLabel: 'తెలుగు' },
  { code: 'ta', label: 'Tamil',    nativeLabel: 'தமிழ்' },
]

export const translations = {
  // ── Brand / shell ────────────────────────────────────────────────────────
  brandSub: {
    en: 'Ocean Visualization',
    hi: 'महासागर दृश्यावलोकन',
    bn: 'মহাসাগর ভিজ্যুয়ালাইজেশন',
    te: 'సముద్ర దృశ్యీకరణ',
    ta: 'கடல் காட்சிப்படுத்தல்',
  },
  explorerModeBtn: {
    en: 'Explorer Mode',
    hi: 'एक्सप्लोरर मोड',
    bn: 'এক্সপ্লোরার মোড',
    te: 'ఎక్స్‌ప్లోరర్ మోడ్',
    ta: 'ஆய்வு பயன்முறை',
  },
  consoleModeBtn: {
    en: 'Forecaster Console',
    hi: 'फोरकास्टर कंसोल',
    bn: 'ফোরকাস্টার কনসোল',
    te: 'ఫోర్‌కాస్టర్ కన్సోల్',
    ta: 'முன்னறிவிப்பாளர் கன்சோல்',
  },

  // ── Search bar ───────────────────────────────────────────────────────────
  searchPlaceholder: {
    en: 'Search a sea or region (e.g. Arabian Sea)…',
    hi: 'किसी सागर या क्षेत्र को खोजें (जैसे अरब सागर)…',
    bn: 'একটি সাগর বা অঞ্চল অনুসন্ধান করুন (যেমন আরব সাগর)…',
    te: 'ఒక సముద్రం లేదా ప్రాంతాన్ని వెతకండి (ఉదా. అరేబియా సముద్రం)…',
    ta: 'ஒரு கடல் அல்லது பகுதியைத் தேடுங்கள் (எ.கா. அரபிக் கடல்)…',
  },
  noRegionSelected: {
    en: 'No region selected — search above to load ocean data.',
    hi: 'कोई क्षेत्र चयनित नहीं — महासागर डेटा लोड करने के लिए ऊपर खोजें।',
    bn: 'কোনো অঞ্চল নির্বাচিত হয়নি — মহাসাগরের ডেটা লোড করতে উপরে অনুসন্ধান করুন।',
    te: 'ప్రాంతం ఎంపిక కాలేదు — సముద్ర డేటాను లోడ్ చేయడానికి పైన వెతకండి.',
    ta: 'பகுதி எதுவும் தேர்ந்தெடுக்கப்படவில்லை — கடல் தரவை ஏற்ற மேலே தேடுங்கள்.',
  },
  fetchingData: {
    en: 'Fetching ocean data for this region… first-time searches outside the Bay of Bengal pull live from Copernicus Marine and can take up to a minute.',
    hi: 'इस क्षेत्र के लिए महासागर डेटा प्राप्त किया जा रहा है… बंगाल की खाड़ी के बाहर पहली बार खोज Copernicus Marine से लाइव डेटा लाती है और इसमें एक मिनट तक लग सकता है।',
    bn: 'এই অঞ্চলের জন্য মহাসাগরের ডেটা আনা হচ্ছে… বঙ্গোপসাগরের বাইরে প্রথমবার অনুসন্ধান Copernicus Marine থেকে লাইভ ডেটা আনে এবং এতে এক মিনিট পর্যন্ত সময় লাগতে পারে।',
    te: 'ఈ ప్రాంతానికి సముద్ర డేటాను పొందుతోంది… బంగాళాఖాతం వెలుపల మొదటిసారి శోధనలు Copernicus Marine నుండి ప్రత్యక్షంగా డేటాను తెస్తాయి, ఇది ఒక నిమిషం వరకు పట్టవచ్చు.',
    ta: 'இப்பகுதிக்கான கடல் தரவு பெறப்படுகிறது… வங்காள விரிகுடாவிற்கு வெளியே முதல் முறை தேடல்கள் Copernicus Marine இலிருந்து நேரடியாக தரவைப் பெறும், இது ஒரு நிமிடம் வரை ஆகலாம்.',
  },
  searchFailed: {
    en: 'Search failed — check your connection and try again.',
    hi: 'खोज विफल रही — अपना कनेक्शन जांचें और पुनः प्रयास करें।',
    bn: 'অনুসন্ধান ব্যর্থ হয়েছে — আপনার সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।',
    te: 'శోధన విఫలమైంది — మీ కనెక్షన్‌ని తనిఖీ చేసి మళ్లీ ప్రయత్నించండి.',
    ta: 'தேடல் தோல்வியடைந்தது — உங்கள் இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.',
  },
  noMatch: {
    en: 'No match for "{query}" — try a different name.',
    hi: '"{query}" के लिए कोई मेल नहीं मिला — कोई दूसरा नाम आज़माएं।',
    bn: '"{query}" এর জন্য কোনো মিল পাওয়া যায়নি — একটি ভিন্ন নাম চেষ্টা করুন।',
    te: '"{query}" కోసం సరిపోలిక కనుగొనబడలేదు — వేరే పేరు ప్రయత్నించండి.',
    ta: '"{query}" க்கு பொருத்தம் இல்லை — வேறு பெயரை முயற்சிக்கவும்.',
  },

  // ── Control panel sections ───────────────────────────────────────────────
  dataSource: {
    en: 'Data Source',
    hi: 'डेटा स्रोत',
    bn: 'ডেটা উৎস',
    te: 'డేటా మూలం',
    ta: 'தரவு மூலம்',
  },
  variable: {
    en: 'Variable',
    hi: 'चर',
    bn: 'ভেরিয়েবল',
    te: 'చరరాశి',
    ta: 'மாறி',
  },
  renderMode: {
    en: 'Render Mode',
    hi: 'रेंडर मोड',
    bn: 'রেন্ডার মোড',
    te: 'రెండర్ మోడ్',
    ta: 'காட்சி பயன்முறை',
  },
  modeSlice: {
    en: 'Slice',
    hi: 'स्लाइस',
    bn: 'স্লাইস',
    te: 'స్లైస్',
    ta: 'துண்டு',
  },
  modeVolume: {
    en: 'Volume',
    hi: 'वॉल्यूम',
    bn: 'ভলিউম',
    te: 'వాల్యూమ్',
    ta: 'கன அளவு',
  },
  modeIso: {
    en: 'Iso',
    hi: 'आइसो',
    bn: 'আইসো',
    te: 'ఐసో',
    ta: 'ஐசோ',
  },
  threshold: {
    en: 'Threshold',
    hi: 'थ्रेशोल्ड',
    bn: 'থ্রেশহোল্ড',
    te: 'థ్రెషోల్డ్',
    ta: 'நுழைவு வரம்பு',
  },
  depth: {
    en: 'Depth',
    hi: 'गहराई',
    bn: 'গভীরতা',
    te: 'లోతు',
    ta: 'ஆழம்',
  },
  timeStep: {
    en: 'Time Step',
    hi: 'समय चरण',
    bn: 'সময় ধাপ',
    te: 'సమయ దశ',
    ta: 'நேர படி',
  },
  colormap: {
    en: 'Colormap',
    hi: 'कलरमैप',
    bn: 'কালারম্যাপ',
    te: 'కలర్‌మ్యాప్',
    ta: 'வண்ண வரைபடம்',
  },
  logScale: {
    en: 'Log scale',
    hi: 'लॉग स्केल',
    bn: 'লগ স্কেল',
    te: 'లాగ్ స్కేల్',
    ta: 'லாக் அளவீடு',
  },
  min: {
    en: 'Min',
    hi: 'न्यूनतम',
    bn: 'সর্বনিম্ন',
    te: 'కనిష్ఠ',
    ta: 'குறைந்தபட்சம்',
  },
  max: {
    en: 'Max',
    hi: 'अधिकतम',
    bn: 'সর্বোচ্চ',
    te: 'గరిష్ఠ',
    ta: 'அதிகபட்சம்',
  },
  opacity: {
    en: 'Opacity',
    hi: 'अपारदर्शिता',
    bn: 'অস্বচ্ছতা',
    te: 'అపారదర్శకత',
    ta: 'ஒளிபுகா தன்மை',
  },
  vertExaggeration: {
    en: 'Vert. Exaggeration',
    hi: 'ऊर्ध्वाधर अतिशयोक्ति',
    bn: 'উল্লম্ব অতিরঞ্জন',
    te: 'నిలువు అతిశయోక్తి',
    ta: 'செங்குத்து மிகைப்படுத்தல்',
  },
  layers: {
    en: 'Layers',
    hi: 'परतें',
    bn: 'স্তরসমূহ',
    te: 'పొరలు',
    ta: 'அடுக்குகள்',
  },

  // ── Layer names (keyed to layerVisibility ids) ──────────────────────────
  layerSlice: {
    en: 'Slice',
    hi: 'स्लाइस',
    bn: 'স্লাইস',
    te: 'స్లైస్',
    ta: 'துண்டு',
  },
  layerVolume: {
    en: 'Volume',
    hi: 'वॉल्यूम',
    bn: 'ভলিউম',
    te: 'వాల్యూమ్',
    ta: 'கன அளவு',
  },
  layerIsosurface: {
    en: 'Isosurface',
    hi: 'आइसोसरफेस',
    bn: 'আইসোসারফেস',
    te: 'ఐసోసర్ఫేస్',
    ta: 'சம மேற்பரப்பு',
  },
  layerMarkers: {
    en: 'Markers',
    hi: 'मार्कर',
    bn: 'মার্কার',
    te: 'మార్కర్లు',
    ta: 'குறியீடுகள்',
  },
  layerVectors: {
    en: 'Vectors',
    hi: 'वेक्टर',
    bn: 'ভেক্টর',
    te: 'వెక్టార్లు',
    ta: 'திசையன்கள்',
  },

  // ── Explorer mode flythrough ─────────────────────────────────────────────
  explorerBrandSub: {
    en: 'SIH 2026 · INCOIS Ocean Visualization',
    hi: 'SIH 2026 · INCOIS महासागर दृश्यावलोकन',
    bn: 'SIH 2026 · INCOIS মহাসাগর ভিজ্যুয়ালাইজেশন',
    te: 'SIH 2026 · INCOIS సముద్ర దృశ్యీకరణ',
    ta: 'SIH 2026 · INCOIS கடல் காட்சிப்படுத்தல்',
  },
  flythrough1: {
    en: 'Welcome to TARANG — Exploring the Bay of Bengal',
    hi: 'TARANG में आपका स्वागत है — बंगाल की खाड़ी की खोज',
    bn: 'TARANG-এ স্বাগতম — বঙ্গোপসাগর অন্বেষণ',
    te: 'TARANG కి స్వాగతం — బంగాళాఖాతం అన్వేషణ',
    ta: 'TARANG-க்கு வரவேற்கிறோம் — வங்காள விரிகுடாவை ஆராய்தல்',
  },
  flythrough2: {
    en: '🌊 The Bay of Bengal: home to over 500 active Argo ocean floats',
    hi: '🌊 बंगाल की खाड़ी: 500 से अधिक सक्रिय आर्गो महासागर फ्लोट्स का घर',
    bn: '🌊 বঙ্গোপসাগর: ৫০০টিরও বেশি সক্রিয় আর্গো মহাসাগর ফ্লোটের আবাসস্থল',
    te: '🌊 బంగాళాఖాతం: 500కి పైగా క్రియాశీల ఆర్గో సముద్ర ఫ్లోట్‌లకు నెలవు',
    ta: '🌊 வங்காள விரிகுடா: 500க்கும் மேற்பட்ட செயலில் உள்ள ஆர்கோ கடல் மிதவைகளின் தாயகம்',
  },
  flythrough3: {
    en: '🌡️ Warm surface waters (28–30°C) drive the Indian monsoon system',
    hi: '🌡️ गर्म सतही जल (28–30°C) भारतीय मानसून प्रणाली को संचालित करता है',
    bn: '🌡️ উষ্ণ পৃষ্ঠজল (২৮–৩০°সে) ভারতীয় বর্ষা ব্যবস্থা চালিত করে',
    te: '🌡️ వెచ్చని ఉపరితల జలాలు (28–30°C) భారత రుతుపవన వ్యవస్థను నడిపిస్తాయి',
    ta: '🌡️ சூடான மேற்பரப்பு நீர் (28–30°C) இந்திய பருவமழை அமைப்பை இயக்குகிறது',
  },
  flythrough4: {
    en: '🔵 Beneath the surface: cooler, saltier water masses at depth',
    hi: '🔵 सतह के नीचे: गहराई में ठंडे, अधिक खारे जल द्रव्यमान',
    bn: '🔵 পৃষ্ঠের নিচে: গভীরতায় শীতল, লবণাক্ত জলরাশি',
    te: '🔵 ఉపరితలం క్రింద: లోతులో చల్లని, ఉప్పగా ఉండే నీటి ద్రవ్యరాశులు',
    ta: '🔵 மேற்பரப்புக்கு அடியில்: ஆழத்தில் குளிர்ந்த, உப்புத்தன்மை கூடிய நீர்நிலைகள்',
  },
  flythrough5: {
    en: '⚡ Ocean currents carry heat that affects weather across South Asia',
    hi: '⚡ महासागरीय धाराएं गर्मी ले जाती हैं जो दक्षिण एशिया के मौसम को प्रभावित करती हैं',
    bn: '⚡ মহাসাগরীয় স্রোত তাপ বহন করে যা দক্ষিণ এশিয়া জুড়ে আবহাওয়াকে প্রভাবিত করে',
    te: '⚡ సముద్ర ప్రవాహాలు దక్షిణాసియా వాతావరణాన్ని ప్రభావితం చేసే వేడిని మోసుకెళ్తాయి',
    ta: '⚡ கடல் நீரோட்டங்கள் தென் ஆசியா முழுவதும் வானிலையை பாதிக்கும் வெப்பத்தை சுமந்து செல்கின்றன',
  },
  flythrough6: {
    en: '🔬 Scientists at INCOIS monitor these patterns every day to protect coastal communities',
    hi: '🔬 INCOIS के वैज्ञानिक तटीय समुदायों की सुरक्षा के लिए हर दिन इन पैटर्न की निगरानी करते हैं',
    bn: '🔬 INCOIS-এর বিজ্ঞানীরা উপকূলীয় সম্প্রদায়কে রক্ষা করতে প্রতিদিন এই নিদর্শনগুলি পর্যবেক্ষণ করেন',
    te: '🔬 తీర ప్రాంత సమాజాలను రక్షించడానికి INCOIS శాస్త్రవేత్తలు ప్రతిరోజూ ఈ నమూనాలను పర్యవేక్షిస్తారు',
    ta: '🔬 கடலோர சமூகங்களைப் பாதுகாக்க INCOIS விஞ்ஞானிகள் இந்த முறைகளை தினமும் கண்காணிக்கின்றனர்',
  },
} satisfies Record<string, Record<LanguageCode, string>>

export type TranslationKey = keyof typeof translations
