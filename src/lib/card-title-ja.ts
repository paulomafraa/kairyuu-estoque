import { stripCardPriceSuffix } from "@/lib/cobranca-msg";

const FORMS: Array<[RegExp, string]> = [
  [/^alolan\s+/i, "アローラ"],
  [/^galarian\s+/i, "ガラル"],
  [/^hisuian\s+/i, "ヒスイ"],
  [/^paldean\s+/i, "パルデア"],
  [/^mega\s+/i, "メガ"],
  [/^m\.\s*/i, "メガ"],
  [/^dark\s+/i, "わるい"],
  [/^shining\s+/i, "ひかる"],
  [/^team\s+rocket'?s?\s+/i, "ロケット団の"],
];

const TRAINERS: Array<[RegExp, string]> = [
  [/^erika'?s\s+/i, "エリカの"],
  [/^misty'?s\s+/i, "カスミの"],
  [/^brock'?s\s+/i, "タケシの"],
  [/^lt\.?\s*surge'?s\s+/i, "マチスの"],
  [/^blaine'?s\s+/i, "カツラの"],
  [/^sabrina'?s\s+/i, "ナツメの"],
  [/^giovanni'?s\s+/i, "サカキの"],
  [/^koga'?s\s+/i, "キョウの"],
];

const SUFFIXES: Array<[RegExp, string]> = [
  [/\s+vstar$/i, "VSTAR"],
  [/\s+vmax$/i, "VMAX"],
  [/\s+v-ex$/i, "V-EX"],
  [/\s+gx$/i, "GX"],
  [/\s+ex$/i, "EX"],
  [/\s+break$/i, "BREAK"],
  [/\s+legend$/i, "LEGEND"],
  [/\s+lv\.?\s*x$/i, "LV.X"],
  [/\s+v$/i, "V"],
];

/** Nome em inglês (TCG) → katakana/oficial. */
const POKEMON_JA: Record<string, string> = {
  arceus: "アルセウス",
  articuno: "フリーザー",
  buzzwole: "マッシブーン",
  celebi: "セレビィ",
  chandelure: "シャンデラ",
  chanderule: "シャンデラ",
  charizard: "リザードン",
  cresselia: "クレセリア",
  crobat: "クロバット",
  darkrai: "ダークライ",
  delcatty: "エネコロロ",
  ditto: "メタモン",
  drifloon: "フワンテ",
  exeggutor: "ナッシー",
  fuecoco: "ホゲータ",
  gardevoir: "サーナイト",
  genesect: "ゲノセクト",
  gengar: "ゲンガー",
  gholdengo: "サーフゴー",
  greninja: "ゲッコウガ",
  jigglypuff: "プリン",
  jirachi: "ジラーチ",
  "kommo-o": "ジャラランガ",
  kommoo: "ジャラランガ",
  lapras: "ラプラス",
  lugia: "ルギア",
  lycanroc: "ルガルガン",
  magikarp: "コイキング",
  maushold: "イッカネズミ",
  meowth: "ニャース",
  metagross: "メタグロス",
  mew: "ミュウ",
  mewtwo: "ミュウツー",
  misty: "カスミ",
  moltres: "ファイヤー",
  morpeko: "モルペコ",
  n: "N",
  nidorina: "ニドリーナ",
  palkia: "パルキア",
  pikachu: "ピカチュウ",
  raikou: "ライコウ",
  rayquaza: "レックウザ",
  salamence: "ボーマンダ",
  scizor: "ハッサム",
  scraggy: "ズルッグ",
  sneasel: "ニューラ",
  solgaleo: "ソルガレオ",
  sylveon: "ニンフィア",
  toxtricity: "ストリンダー",
  tyranitar: "バンギラス",
  uxie: "ユクシー",
  zacian: "ザシアン",
  zapdos: "サンダー",
  zorua: "ゾロア",
  zoroark: "ゾロアーク",
  eevee: "イーブイ",
  umbreon: "ブラッキー",
  espeon: "エーフィ",
  vaporeon: "シャワーズ",
  jolteon: "サンダース",
  flareon: "ブースター",
  leafeon: "リーフィア",
  glaceon: "グレイシア",
  lucario: "ルカリオ",
  garchomp: "ガブリアス",
  dialga: "ディアルガ",
  giratina: "ギラティナ",
  groudon: "グラードン",
  kyogre: "カイオーガ",
  snorlax: "カビゴン",
  dragonite: "カイリュー",
  gyarados: "ギャラドス",
  blastoise: "カメックス",
  venusaur: "フシギバナ",
};

function lookupPokemon(raw: string): string {
  const key = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return raw;
  if (POKEMON_JA[key]) return POKEMON_JA[key];
  const compact = key.replace(/[\s-]+/g, "");
  if (POKEMON_JA[compact]) return POKEMON_JA[compact];
  return raw;
}

function translateNameCore(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  for (const [re, ja] of TRAINERS) {
    if (re.test(s)) {
      s = s.replace(re, ja);
      break;
    }
  }
  for (const [re, ja] of FORMS) {
    if (re.test(s)) {
      s = s.replace(re, ja);
      break;
    }
  }
  let suffix = "";
  for (const [re, ja] of SUFFIXES) {
    if (re.test(s)) {
      s = s.replace(re, "");
      suffix = ja;
      break;
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  const parts = s.split(/\s*(?:&| e | and |／|\/)\s*/i).filter(Boolean);
  const translated = parts.map((p) => {
    const g = p.match(/^(.+?)\s+g$/i);
    if (g) return `${lookupPokemon(g[1])}G`;
    return lookupPokemon(p);
  });
  const joiner = parts.length > 1 && /&| e | and /i.test(raw) ? "&" : "";
  const body =
    translated.length > 1 && joiner
      ? translated.join("&")
      : translated.join("");
  return `${body}${suffix}`;
}

/** Título da carta (EN) → japonês, mantém numeração (104/103) e variantes (B/RGB). */
export function cardTitleToJa(title: string): string {
  const stripped = stripCardPriceSuffix(title);
  if (!stripped) return title;
  const extras: string[] = [];
  let core = stripped;
  const re = /\s*(\([^)]+\))\s*$/;
  while (re.test(core)) {
    extras.unshift(core.match(re)![1]);
    core = core.replace(re, "").trim();
  }
  const ja = translateNameCore(core);
  return [ja, ...extras].filter(Boolean).join(" ");
}
