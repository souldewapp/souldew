// The coffee pop-up: when a player meets a legendary or mythical Pokémon while live tracking runs, the stream
// overlay (web/overlay.html) may show a small corner toast with a joke about THAT Pokémon and the "Buy me a coffee"
// link + QR code. The server decides (server/lib/streamapi.mjs) with the pure rules below, so they can be tested:
// one deterministic 25 % roll per species and run, at most one pop-up every 20 minutes, never while switched off.

import { legendaryKind, isLegendary } from './legendaries.mjs';
import { LINKS } from './links.mjs';

export const COFFEE = Object.freeze({
  chance: 0.25,
  cooldownMs: 20 * 60 * 1000,
  showMs: 12000,
  freshMs: 5 * 60 * 1000, // a battle reported later than this (a sync catching up) doesn't count
});
export const COFFEE_CORNERS = ['tl', 'tr', 'bl', 'br'];
export const DEFAULT_CORNER = 'bl';
export const COFFEE_URL = LINKS.coffee;
/** "buymeacoffee.com/souldew" – the link as the pop-up prints it. */
export const COFFEE_SHORT = COFFEE_URL.replace(/^https?:\/\/(www\.)?/, '');

/** FNV-1a (32 bit) of a string, with MurmurHash3's finalizer so every bit depends on every character. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 1) that only depends on `seed` – the pop-up's dice. */
export const coffeeRoll = (seed) => hash32(seed) / 0x100000000;

/**
 * Should a wild battle against `species` show the pop-up? `history` = { last: time of the last pop-up,
 * runs: { [runId]: [species already rolled for] } }. Every species gets one roll per run (the same one on every
 * computer: the dice are runId + species); a lucky roll inside the 20-minute cooldown waits for the next encounter.
 * → { show, reason: 'off' | 'notLegendary' | 'seen' | 'unlucky' | 'cooldown' | 'ok', roll?, record }
 * `record`: remember the species as rolled (see recordCoffee).
 */
export function decideCoffee({ enabled = true, history = {}, runId, species, now = Date.now(), chance = COFFEE.chance, roll = null } = {}) {
  if (!enabled) return { show: false, reason: 'off', record: false };
  if (!isLegendary(species)) return { show: false, reason: 'notLegendary', record: false };
  const seen = history?.runs?.[runId];
  if (Array.isArray(seen) && seen.includes(species)) return { show: false, reason: 'seen', record: false };
  const r = roll ?? coffeeRoll(`${runId}:${species}`);
  if (r >= chance) return { show: false, reason: 'unlucky', roll: r, record: true };
  if (Number.isFinite(history?.last) && now - history.last < COFFEE.cooldownMs && now >= history.last) {
    return { show: false, reason: 'cooldown', roll: r, record: false };
  }
  return { show: true, reason: 'ok', roll: r, record: true };
}

/** The history after a decision (a new object; the 40 most recent runs are kept). */
export function recordCoffee(history, runId, species, decision, now = Date.now()) {
  const runs = { ...(history?.runs || {}) };
  if (decision?.record) {
    const list = Array.isArray(runs[runId]) ? runs[runId] : [];
    delete runs[runId];
    runs[runId] = [...list.filter((x) => x !== species), species].slice(-200);
  }
  const ids = Object.keys(runs);
  for (const id of ids.slice(0, Math.max(0, ids.length - 40))) delete runs[id];
  return { last: decision?.show ? now : history?.last ?? null, runs };
}

// ---- texts -----------------------------------------------------------------------------------------------------
// {name} is the Pokémon's name in the overlay's language. Species that share a joke are grouped (Regis, lake trio …).
const GROUPS = { 377: 'regi', 378: 'regi', 379: 'regi', 380: 'lati', 381: 'lati', 480: 'lake', 481: 'lake', 482: 'lake', 489: 'mana', 490: 'mana',
  638: 'swords', 639: 'swords', 640: 'swords', 641: 'forces', 642: 'forces', 645: 'forces' };
const jokeKey = (id) => GROUPS[id] || String(id);

export const COFFEE_TEXT = {
  en: {
    legendary: 'Legendary encounter', mythical: 'Mythical encounter', cta: 'Buy the souldew dev a coffee', scan: 'Scan or visit',
    species: {
      144: '{name} appeared. The dev’s coffee froze solid just looking at it.',
      145: '{name} is fully charged. The dev runs on coffee instead – top them up?',
      146: '{name} brought the heat. The dev brought an empty mug.',
      150: '{name} has entered the chat. souldew’s developer has entered the coffee shortage.',
      151: 'A wild {name}? Under the truck, they said. The dev’s coffee budget is under there too.',
      243: '{name} will flee in 3… 2… Your chance to buy the dev a coffee won’t.',
      244: '{name} roams Johto. The dev roams the kitchen looking for coffee.',
      245: '{name} purifies water. The dev turns it into coffee – with your help.',
      249: '{name} rose from the depths. So did the dev – at 3 a.m., for coffee.',
      250: '{name} spotted! Legend says whoever sees it… buys the dev a coffee.',
      251: '{name} travels through time. The dev would just like to skip to coffee o’clock.',
      regi: '{name} only speaks braille. The dev only speaks after coffee.',
      lati: '{name} can turn invisible. So can the dev’s coffee supply.',
      382: '{name} is flooding the screen. The dev’s mug, sadly, is bone dry.',
      383: '{name} dried up the seas. And the dev’s coffee pot.',
      384: 'This {name} won’t catch itself. The dev’s rent won’t pay itself either.',
      385: '{name} grants one wish every thousand years. The dev wishes for coffee – you’re faster.',
      386: '{name} came from space. The dev’s coffee money seems to have gone there too.',
      lake: '{name} erases memories. Please don’t forget the dev’s coffee.',
      483: '{name} controls time. The dev controls nothing before the first coffee.',
      484: '{name} bends space. The dev bends over backwards for this app – on coffee.',
      485: '{name} lives in a volcano. Perfect temperature for a coffee, honestly.',
      486: '{name} takes ages to get going. Like the dev without coffee.',
      487: '{name} rules the Distortion World. That’s where the dev’s sleep schedule lives.',
      488: '{name} brings sweet dreams. The dev would settle for a coffee.',
      mana: '{name} looks so innocent. So does this coffee button.',
      491: '{name} brings nightmares. Like the dev’s to-do list. Coffee helps.',
      492: '{name} spreads flowers. You could spread a coffee.',
      493: '{name} created the universe. The dev created souldew – on coffee.',
      494: '{name} brings victory. A coffee brings the next update.',
      swords: '{name} protects Pokémon from humans. Who protects the dev from an empty mug?',
      forces: '{name} is a force of nature. So is the dev’s need for caffeine.',
      643: '{name} seeks the truth. The truth is: the dev needs coffee.',
      644: '{name} seeks ideals. Ideal world: the dev’s mug is never empty.',
      646: '{name} is ice cold. So is the dev’s last coffee.',
      647: '{name} is still learning. The dev is still debugging – fuelled by coffee.',
      648: '{name} sings. The dev hums along – once there’s coffee.',
      649: '{name} got a cannon. The dev would settle for a coffee machine.',
    },
    generic: [
      'A wild {name} appeared! A wild coffee button appeared too.',
      '{name}! Rarer than the dev getting eight hours of sleep.',
      'Encounter rate of {name}: tiny. Encounter rate of coffee for the dev: also tiny.',
      '{name} on stream! Quick, throw a Master Ball – or a coffee.',
      'The dev’s coffee fund is at Magikarp power level. Splash! {name} could help… so could you.',
      'Chat, {name} is here. Reminder: the dev isn’t legendary, just tired.',
      '{name} spotted! The dev is only legendary at forgetting lunch. Coffee helps.',
      '{name} doesn’t need a coffee. Whoever coded this tracker does.',
    ],
  },
  de: {
    legendary: 'Legendäre Begegnung', mythical: 'Mysteriöse Begegnung', cta: 'Spendier dem souldew-Dev einen Kaffee', scan: 'Scannen oder öffnen',
    species: {
      144: '{name} ist aufgetaucht. Dem Dev ist beim Anblick der Kaffee eingefroren.',
      145: '{name} ist voll aufgeladen. Der Dev läuft auf Kaffee – lädst du ihn auf?',
      146: '{name} bringt die Hitze. Der Dev bringt nur eine leere Tasse.',
      150: '{name} ist dem Chat beigetreten. Der souldew-Dev ist der Kaffeeknappheit beigetreten.',
      151: 'Ein wildes {name}? Liegt angeblich unterm Truck. Das Kaffeebudget des Devs liegt da auch.',
      243: '{name} flieht in 3 … 2 … Deine Chance, dem Dev einen Kaffee auszugeben, bleibt.',
      244: '{name} streift durch Johto. Der Dev streift durch die Küche – auf der Suche nach Kaffee.',
      245: '{name} reinigt Wasser. Der Dev macht Kaffee draus – mit deiner Hilfe.',
      249: '{name} steigt aus der Tiefe. Der Dev auch – um 3 Uhr nachts, für Kaffee.',
      250: '{name} gesichtet! Die Legende sagt: Wer es sieht, spendiert dem Dev einen Kaffee.',
      251: '{name} reist durch die Zeit. Der Dev wär schon froh, wenn endlich Kaffeepause wär.',
      regi: '{name} spricht nur Blindenschrift. Der Dev spricht erst nach dem ersten Kaffee.',
      lati: '{name} kann sich unsichtbar machen. Der Kaffeevorrat des Devs leider auch.',
      382: '{name} flutet den Bildschirm. Die Tasse des Devs bleibt staubtrocken.',
      383: '{name} lässt die Meere austrocknen. Die Kaffeekanne des Devs gleich mit.',
      384: 'Dieses {name} fängt sich nicht von allein. Die Miete des Devs zahlt sich auch nicht von allein.',
      385: '{name} erfüllt alle tausend Jahre einen Wunsch. Der Dev wünscht sich Kaffee – du bist schneller.',
      386: '{name} kommt aus dem All. Da ist wohl auch das Kaffeegeld des Devs hin.',
      lake: '{name} löscht Erinnerungen. Bitte vergiss den Kaffee für den Dev nicht.',
      483: '{name} beherrscht die Zeit. Der Dev beherrscht vor dem ersten Kaffee gar nichts.',
      484: '{name} verbiegt den Raum. Der Dev verbiegt sich für diese App – mit Kaffee.',
      485: '{name} wohnt in einem Vulkan. Eigentlich die perfekte Temperatur für Kaffee.',
      486: '{name} braucht ewig, um in die Gänge zu kommen. Wie der Dev ohne Kaffee.',
      487: '{name} herrscht über die Zerrwelt. Da wohnt auch der Schlafrhythmus des Devs.',
      488: '{name} bringt süße Träume. Der Dev nimmt auch einen Kaffee.',
      mana: '{name} sieht so unschuldig aus. Dieser Kaffee-Button auch.',
      491: '{name} bringt Albträume. Wie die To-do-Liste des Devs. Kaffee hilft.',
      492: '{name} verteilt Blumen. Du könntest einen Kaffee verteilen.',
      493: '{name} hat das Universum erschaffen. Der Dev hat souldew erschaffen – mit Kaffee.',
      494: '{name} bringt den Sieg. Ein Kaffee bringt das nächste Update.',
      swords: '{name} beschützt Pokémon vor Menschen. Wer beschützt den Dev vor einer leeren Tasse?',
      forces: '{name} ist eine Naturgewalt. Der Koffeinbedarf des Devs auch.',
      643: '{name} sucht die Wahrheit. Die Wahrheit ist: Der Dev braucht Kaffee.',
      644: '{name} sucht Ideale. Ideale Welt: Die Tasse des Devs ist nie leer.',
      646: '{name} ist eiskalt. Genau wie der letzte Kaffee des Devs.',
      647: '{name} lernt noch. Der Dev debuggt noch – mit Kaffee als Treibstoff.',
      648: '{name} singt. Der Dev summt mit – sobald Kaffee da ist.',
      649: '{name} hat eine Kanone bekommen. Der Dev wär mit einer Kaffeemaschine zufrieden.',
    },
    generic: [
      'Ein wildes {name} erscheint! Ein wilder Kaffee-Button erscheint auch.',
      '{name}! Seltener als acht Stunden Schlaf beim Dev.',
      'Begegnungsrate von {name}: winzig. Begegnungsrate von Kaffee beim Dev: auch winzig.',
      '{name} im Stream! Schnell, wirf einen Meisterball – oder einen Kaffee.',
      'Die Kaffeekasse des Devs ist auf Karpador-Niveau. Platscher! {name} könnte helfen … du auch.',
      'Chat, {name} ist da. Zur Erinnerung: Der Dev ist nicht legendär, nur müde.',
      '{name} gesichtet! Legendär ist der Dev nur im Mittagessen-Vergessen. Kaffee hilft.',
      '{name} braucht keinen Kaffee. Wer diesen Tracker programmiert hat, schon.',
    ],
  },
  fr: {
    legendary: 'Rencontre légendaire', mythical: 'Rencontre fabuleuse', cta: 'Offre un café au dev de souldew', scan: 'Scanne ou visite',
    species: {
      144: '{name} est apparu. Le café du dev a gelé rien qu’en le voyant.',
      145: '{name} est chargé à bloc. Le dev, lui, carbure au café – tu le recharges ?',
      146: '{name} apporte la chaleur. Le dev n’apporte qu’une tasse vide.',
      150: '{name} a rejoint le chat. Le dev de souldew a rejoint la pénurie de café.',
      151: 'Un {name} sauvage ? Sous le camion, paraît-il. Le budget café du dev y est aussi.',
      243: '{name} va fuir dans 3… 2… Ta chance d’offrir un café au dev, elle, reste.',
      244: '{name} parcourt Johto. Le dev parcourt la cuisine à la recherche de café.',
      245: '{name} purifie l’eau. Le dev la transforme en café – avec ton aide.',
      249: '{name} surgit des profondeurs. Le dev aussi – à 3 h du matin, pour un café.',
      250: '{name} repéré ! La légende dit que celui qui le voit… offre un café au dev.',
      251: '{name} voyage dans le temps. Le dev aimerait juste avancer jusqu’à la pause café.',
      regi: '{name} ne parle qu’en braille. Le dev ne parle qu’après son café.',
      lati: '{name} peut devenir invisible. La réserve de café du dev aussi.',
      382: '{name} inonde l’écran. La tasse du dev, elle, reste désespérément vide.',
      383: '{name} assèche les mers. Et la cafetière du dev au passage.',
      384: 'Ce {name} ne va pas se capturer tout seul. Le loyer du dev ne va pas se payer tout seul non plus.',
      385: '{name} exauce un vœu tous les mille ans. Le dev rêve d’un café – toi, tu es plus rapide.',
      386: '{name} vient de l’espace. L’argent du café du dev semble y être parti aussi.',
      lake: '{name} efface les souvenirs. N’oublie pas le café du dev, s’il te plaît.',
      483: '{name} contrôle le temps. Le dev ne contrôle rien avant son premier café.',
      484: '{name} plie l’espace. Le dev se plie en quatre pour cette appli – au café.',
      485: '{name} vit dans un volcan. Température idéale pour un café, franchement.',
      486: '{name} met une éternité à démarrer. Comme le dev sans café.',
      487: '{name} règne sur le Monde Distorsion. C’est là que vit le rythme de sommeil du dev.',
      488: '{name} apporte de beaux rêves. Le dev se contenterait d’un café.',
      mana: '{name} a l’air tout innocent. Ce bouton café aussi.',
      491: '{name} apporte des cauchemars. Comme la to-do list du dev. Un café aide.',
      492: '{name} répand des fleurs. Tu pourrais répandre un café.',
      493: '{name} a créé l’univers. Le dev a créé souldew – au café.',
      494: '{name} apporte la victoire. Un café apporte la prochaine mise à jour.',
      swords: '{name} protège les Pokémon des humains. Qui protège le dev d’une tasse vide ?',
      forces: '{name} est une force de la nature. Le besoin de caféine du dev aussi.',
      643: '{name} cherche la vérité. La vérité, c’est que le dev a besoin de café.',
      644: '{name} cherche l’idéal. Monde idéal : la tasse du dev n’est jamais vide.',
      646: '{name} est glacial. Comme le dernier café du dev.',
      647: '{name} apprend encore. Le dev débogue encore – au café.',
      648: '{name} chante. Le dev fredonne avec lui – dès qu’il y a du café.',
      649: '{name} a reçu un canon. Le dev se contenterait d’une machine à café.',
    },
    generic: [
      'Un {name} sauvage apparaît ! Un bouton café sauvage apparaît aussi.',
      '{name} ! Plus rare qu’une nuit de huit heures pour le dev.',
      'Taux de rencontre de {name} : minuscule. Taux de café du dev : minuscule aussi.',
      '{name} en live ! Vite, lance une Master Ball – ou un café.',
      'La caisse à café du dev est au niveau Magicarpe. Trempette ! {name} pourrait aider… toi aussi.',
      'Chat, {name} est là. Rappel : le dev n’est pas légendaire, juste fatigué.',
      '{name} repéré ! Le dev n’est légendaire que pour oublier de déjeuner. Un café aide.',
      '{name} n’a pas besoin de café. La personne qui a codé ce tracker, si.',
    ],
  },
  es: {
    legendary: 'Encuentro legendario', mythical: 'Encuentro singular', cta: 'Invita a un café al dev de souldew', scan: 'Escanea o visita',
    species: {
      144: 'Ha aparecido {name}. Al dev se le ha congelado el café solo de verlo.',
      145: '{name} está cargado a tope. El dev funciona con café – ¿lo recargas?',
      146: '{name} trae el calor. El dev solo trae una taza vacía.',
      150: '{name} se ha unido al chat. El dev de souldew se ha unido a la escasez de café.',
      151: '¿Un {name} salvaje? Debajo del camión, dicen. El presupuesto de café del dev también está ahí.',
      243: '{name} huirá en 3… 2… Tu oportunidad de invitar al dev a un café, no.',
      244: '{name} recorre Johto. El dev recorre la cocina buscando café.',
      245: '{name} purifica el agua. El dev la convierte en café – con tu ayuda.',
      249: '{name} emerge de las profundidades. El dev también – a las 3 de la mañana, a por café.',
      250: '¡{name} a la vista! La leyenda dice que quien lo ve… invita al dev a un café.',
      251: '{name} viaja en el tiempo. El dev solo quiere saltar a la hora del café.',
      regi: '{name} solo habla en braille. El dev solo habla después del café.',
      lati: '{name} puede volverse invisible. Las reservas de café del dev también.',
      382: '{name} inunda la pantalla. La taza del dev, por desgracia, sigue seca.',
      383: '{name} seca los mares. Y de paso la cafetera del dev.',
      384: 'Este {name} no se va a capturar solo. El alquiler del dev tampoco se va a pagar solo.',
      385: '{name} concede un deseo cada mil años. El dev desea un café – tú eres más rápido.',
      386: '{name} viene del espacio. El dinero para café del dev parece haberse ido allí también.',
      lake: '{name} borra recuerdos. Por favor, no olvides el café del dev.',
      483: '{name} controla el tiempo. El dev no controla nada antes del primer café.',
      484: '{name} dobla el espacio. El dev se desvive por esta app – a base de café.',
      485: '{name} vive en un volcán. Temperatura ideal para un café, la verdad.',
      486: 'A {name} le cuesta horrores arrancar. Como al dev sin café.',
      487: '{name} reina en el Mundo Distorsión. Ahí vive el horario de sueño del dev.',
      488: '{name} trae dulces sueños. El dev se conforma con un café.',
      mana: '{name} parece muy inocente. Este botón de café también.',
      491: '{name} trae pesadillas. Como la lista de tareas del dev. Un café ayuda.',
      492: '{name} esparce flores. Tú podrías esparcir un café.',
      493: '{name} creó el universo. El dev creó souldew – a base de café.',
      494: '{name} trae la victoria. Un café trae la próxima actualización.',
      swords: '{name} protege a los Pokémon de los humanos. ¿Quién protege al dev de una taza vacía?',
      forces: '{name} es una fuerza de la naturaleza. Las ganas de cafeína del dev también.',
      643: '{name} busca la verdad. La verdad es que el dev necesita café.',
      644: '{name} busca ideales. Mundo ideal: la taza del dev nunca se vacía.',
      646: '{name} está helado. Como el último café del dev.',
      647: '{name} todavía está aprendiendo. El dev todavía está depurando – a base de café.',
      648: '{name} canta. El dev tararea con él – en cuanto hay café.',
      649: 'A {name} le pusieron un cañón. El dev se conformaría con una cafetera.',
    },
    generic: [
      '¡Un {name} salvaje apareció! También apareció un botón de café salvaje.',
      '¡{name}! Más raro que el dev durmiendo ocho horas.',
      'Probabilidad de encontrar a {name}: mínima. Probabilidad de café para el dev: también mínima.',
      '¡{name} en directo! Rápido, lanza una Master Ball – o un café.',
      'La hucha de café del dev está a nivel Magikarp. ¡Salpicadura! {name} podría ayudar… tú también.',
      'Chat, ha llegado {name}. Recordad: el dev no es legendario, solo está cansado.',
      '¡{name} a la vista! El dev solo es legendario olvidándose de comer. Un café ayuda.',
      '{name} no necesita café. Quien programó este tracker, sí.',
    ],
  },
  it: {
    legendary: 'Incontro leggendario', mythical: 'Incontro misterioso', cta: 'Offri un caffè al dev di souldew', scan: 'Scansiona o visita',
    species: {
      144: 'È apparso {name}. Al dev si è congelato il caffè solo a guardarlo.',
      145: '{name} è carico al massimo. Il dev invece va a caffè – lo ricarichi?',
      146: '{name} porta il caldo. Il dev porta solo una tazza vuota.',
      150: '{name} è entrato in chat. Il dev di souldew è entrato in crisi da caffè.',
      151: 'Un {name} selvatico? Sotto il camion, dicono. Anche il budget caffè del dev è lì sotto.',
      243: '{name} scapperà tra 3… 2… La tua occasione di offrire un caffè al dev, no.',
      244: '{name} vaga per Johto. Il dev vaga per la cucina in cerca di caffè.',
      245: '{name} purifica l’acqua. Il dev la trasforma in caffè – con il tuo aiuto.',
      249: '{name} emerge dagli abissi. Anche il dev – alle 3 di notte, per un caffè.',
      250: '{name} avvistato! La leggenda dice che chi lo vede… offre un caffè al dev.',
      251: '{name} viaggia nel tempo. Il dev vorrebbe solo saltare all’ora del caffè.',
      regi: '{name} parla solo in braille. Il dev parla solo dopo il caffè.',
      lati: '{name} sa diventare invisibile. Anche la scorta di caffè del dev.',
      382: '{name} sta allagando lo schermo. La tazza del dev, purtroppo, resta asciutta.',
      383: '{name} prosciuga i mari. E già che c’è anche la moka del dev.',
      384: 'Questo {name} non si cattura da solo. Nemmeno l’affitto del dev si paga da solo.',
      385: '{name} esaudisce un desiderio ogni mille anni. Il dev desidera un caffè – tu sei più veloce.',
      386: '{name} viene dallo spazio. Anche i soldi per il caffè del dev sembrano finiti lì.',
      lake: '{name} cancella i ricordi. Per favore, non dimenticare il caffè del dev.',
      483: '{name} controlla il tempo. Il dev non controlla niente prima del primo caffè.',
      484: '{name} piega lo spazio. Il dev si fa in quattro per quest’app – a caffè.',
      485: '{name} vive in un vulcano. Temperatura perfetta per un espresso, a dire il vero.',
      486: '{name} ci mette un’eternità a partire. Come il dev senza caffè.',
      487: '{name} regna sul Mondo Distorto. Lì abita il ritmo sonno-veglia del dev.',
      488: '{name} porta sogni d’oro. Al dev basterebbe un caffè.',
      mana: '{name} sembra così innocente. Anche questo pulsante del caffè.',
      491: '{name} porta incubi. Come la lista delle cose da fare del dev. Un caffè aiuta.',
      492: '{name} sparge fiori. Tu potresti offrire un caffè.',
      493: '{name} ha creato l’universo. Il dev ha creato souldew – a caffè.',
      494: '{name} porta la vittoria. Un caffè porta il prossimo aggiornamento.',
      swords: '{name} protegge i Pokémon dagli umani. Chi protegge il dev da una tazza vuota?',
      forces: '{name} è una forza della natura. Anche il bisogno di caffeina del dev.',
      643: '{name} cerca la verità. La verità è che il dev ha bisogno di caffè.',
      644: '{name} cerca ideali. Mondo ideale: la tazza del dev non è mai vuota.',
      646: '{name} è gelido. Come l’ultimo caffè del dev.',
      647: '{name} sta ancora imparando. Il dev sta ancora facendo debug – a caffè.',
      648: '{name} canta. Il dev canticchia con lui – appena c’è il caffè.',
      649: 'A {name} hanno dato un cannone. Al dev basterebbe una macchina del caffè.',
    },
    generic: [
      'Appare un {name} selvatico! Appare anche un pulsante del caffè selvatico.',
      '{name}! Più raro del dev che dorme otto ore.',
      'Probabilità di incontrare {name}: minima. Probabilità di un caffè per il dev: minima anche quella.',
      '{name} in diretta! Presto, lancia una Master Ball – o un caffè.',
      'Il salvadanaio del caffè del dev è a livello Magikarp. Splash! {name} potrebbe aiutare… anche tu.',
      'Chat, è arrivato {name}. Ricordate: il dev non è leggendario, è solo stanco.',
      '{name} avvistato! Il dev è leggendario solo nel dimenticarsi di pranzare. Un caffè aiuta.',
      '{name} non ha bisogno di caffè. Chi ha programmato questo tracker sì.',
    ],
  },
};

export const COFFEE_LANGS = Object.keys(COFFEE_TEXT);
const langOf = (lang) => (COFFEE_TEXT[String(lang || '').slice(0, 2)] ? String(lang).slice(0, 2) : 'en');

/**
 * Which joke a pop-up shows – the same idea in every language: `species:<key>` for the famous ones, else one of the
 * generic templates, picked by `seed` (stable for a run and species).
 */
export function coffeeJokeId(species, seed = '') {
  const key = jokeKey(Number(species));
  if (COFFEE_TEXT.en.species[key]) return `species:${key}`;
  return `generic:${hash32(`${seed}:${species}`) % COFFEE_TEXT.en.generic.length}`;
}

/** The pop-up's texts in `lang`: { kicker, joke, cta, scan, url, short }. `name` is the species' name in that language. */
export function coffeeTexts({ species, name, lang = 'en', jokeId = null, seed = '' } = {}) {
  const L = COFFEE_TEXT[langOf(lang)];
  const id = jokeId || coffeeJokeId(species, seed);
  const [kind, key] = String(id).split(':');
  const tpl = (kind === 'species' ? L.species[key] : L.generic[Number(key)]) || L.generic[0];
  return {
    kicker: legendaryKind(species) === 'mythical' ? L.mythical : L.legendary,
    joke: tpl.replace(/\{name\}/g, name || `#${species}`),
    cta: L.cta, scan: L.scan, url: COFFEE_URL, short: COFFEE_SHORT,
  };
}
