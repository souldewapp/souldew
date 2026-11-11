// Names and descriptions of the trophies, in the UI language. The rules live in shared/trophies.mjs; every id
// there has its text here (test/trophies-ui.test.mjs checks that none is missing). Descriptions take {n} – the
// target of a counted achievement.
import { t } from './i18n.mjs';

const ACH = () => ({
  // journey
  firstRun: [t('ach.firstRun', 'Press Start'), t('ach.firstRun.d', 'Start your first run.')],
  firstCatch: [t('ach.firstCatch', 'Gotcha!'), t('ach.firstCatch.d', 'Catch your first Pokémon.')],
  catches50: [t('ach.catches50', 'Ball Hoarder'), t('ach.catches50.d', 'Catch {n} Pokémon across all your runs.')],
  catches250: [t('ach.catches250', 'PC Box Overflow'), t('ach.catches250.d', 'Catch {n} Pokémon across all your runs.')],
  firstBadge: [t('ach.firstBadge', 'Shiny Pin'), t('ach.firstBadge.d', 'Earn your first badge.')],
  badges8: [t('ach.badges8', 'Eight for Eight'), t('ach.badges8.d', 'Earn all 8 badges in a single run.')],
  badges16: [t('ach.badges16', 'Two Regions, One Trainer'), t('ach.badges16.d', 'Earn 16 badges in a single run.')],
  badges50: [t('ach.badges50', 'Badge Collector'), t('ach.badges50.d', 'Earn {n} badges across all your runs.')],
  firstWin: [t('ach.firstWin', 'Hall of Fame'), t('ach.firstWin.d', 'Finish a run as won.')],
  winSoulLink: [t('ach.winSoulLink', 'Bound by Fate'), t('ach.winSoulLink.d', 'Win a SoulLink.')],
  winNuzlocke: [t('ach.winNuzlocke', 'Lone Survivor'), t('ach.winNuzlocke.d', 'Win a solo Nuzlocke.')],
  wins5: [t('ach.wins5', 'Seasoned Champion'), t('ach.wins5.d', 'Win {n} runs.')],
  runs10: [t('ach.runs10', 'Again! Again!'), t('ach.runs10.d', 'Start {n} runs.')],
  allGens: [t('ach.allGens', 'Time Traveller'), t('ach.allGens.d', 'Play a run in every generation souldew supports (Gen 1–7).')],
  level100: [t('ach.level100', 'Level 100'), t('ach.level100.d', 'Raise one of your Pokémon to level 100.')],
  firstEvolution: [t('ach.firstEvolution', 'What? It’s Evolving!'), t('ach.firstEvolution.d', 'Evolve a Pokémon.')],
  evolutions25: [t('ach.evolutions25', 'Metamorphosis'), t('ach.evolutions25.d', 'Evolve {n} Pokémon.')],
  hardcoreWin: [t('ach.hardcoreWin', 'Hardcore Legend'), t('ach.hardcoreWin.d', 'Win a Nuzlocke with the Hardcore rules.')],
  // collection
  dex10: [t('ach.dex10', 'Field Notes'), t('ach.dex10.d', 'Catch {n} different species.')],
  dex50: [t('ach.dex50', 'Field Researcher'), t('ach.dex50.d', 'Catch {n} different species.')],
  dex100: [t('ach.dex100', 'Centurion'), t('ach.dex100.d', 'Catch {n} different species.')],
  dex250: [t('ach.dex250', 'Professor’s Pride'), t('ach.dex250.d', 'Catch {n} different species.')],
  dex500: [t('ach.dex500', 'Walking Encyclopedia'), t('ach.dex500.d', 'Catch {n} different species.')],
  dexKanto: [t('ach.dexKanto', 'Kanto Complete'), t('ach.dexKanto.d', 'Catch every species from #1 to #151 – event-only Pokémon excluded.')],
  dexJohto: [t('ach.dexJohto', 'Johto Complete'), t('ach.dexJohto.d', 'Catch every species from #152 to #251 – event-only Pokémon excluded.')],
  dexHoenn: [t('ach.dexHoenn', 'Hoenn Complete'), t('ach.dexHoenn.d', 'Catch every species from #252 to #386 – event-only Pokémon excluded.')],
  dexSinnoh: [t('ach.dexSinnoh', 'Sinnoh Complete'), t('ach.dexSinnoh.d', 'Catch every species from #387 to #493 – event-only Pokémon excluded.')],
  dexUnova: [t('ach.dexUnova', 'Unova Complete'), t('ach.dexUnova.d', 'Catch every species from #494 to #649 – event-only Pokémon excluded.')],
  dexKalos: [t('ach.dexKalos', 'Kalos Complete'), t('ach.dexKalos.d', 'Catch every species from #650 to #721 – event-only Pokémon excluded.')],
  dexAlola: [t('ach.dexAlola', 'Alola Complete'), t('ach.dexAlola.d', 'Catch every species from #722 to #809 – event-only Pokémon excluded.')],
  dexNational: [t('ach.dexNational', 'Gotta Catch ’Em All'), t('ach.dexNational.d', 'Catch all {n} species you can catch in the games souldew plays – event-only Pokémon excluded.')],
  seen100: [t('ach.seen100', 'Eyes Everywhere'), t('ach.seen100.d', 'See {n} different species.')],
  firstShiny: [t('ach.firstShiny', 'Something Sparkly'), t('ach.firstShiny.d', 'Catch a shiny Pokémon.')],
  shiny5: [t('ach.shiny5', 'Shiny Hunter'), t('ach.shiny5.d', 'Catch {n} shiny Pokémon.')],
  legendary: [t('ach.legendary', 'Legend Has It'), t('ach.legendary.d', 'Catch a legendary or mythical Pokémon.')],
  legendary5: [t('ach.legendary5', 'Myth Buster'), t('ach.legendary5.d', 'Catch {n} different legendary or mythical Pokémon.')],
  starterTrio: [t('ach.starterTrio', 'Starter Pack'), t('ach.starterTrio.d', 'Own all three starters of one generation across your runs.')],
  eevee: [t('ach.eevee', 'Eevee Enthusiast'), t('ach.eevee.d', 'Own {n} different Eevee evolutions across your runs.')],
  fossil: [t('ach.fossil', 'Jurassic Pokémon'), t('ach.fossil.d', 'Own a fossil Pokémon.')],
  allTypes: [t('ach.allTypes', 'Type Collector'), t('ach.allTypes.d', 'Own Pokémon of all {n} classic types.')],
  zubat: [t('ach.zubat', 'Not Another Zubat'), t('ach.zubat.d', 'Catch a Zubat in {n} different runs.')],
  // skill
  cleanBadge: [t('ach.cleanBadge', 'Flawless Victory'), t('ach.cleanBadge.d', 'Earn a badge without a single death since the one before.')],
  cleanFour: [t('ach.cleanFour', 'Clean Sheet'), t('ach.cleanFour.d', 'Earn the first four badges of a run without a death.')],
  deathlessWin: [t('ach.deathlessWin', 'Untouchable'), t('ach.deathlessWin.d', 'Win a run without a single death.')],
  lowDeathWin: [t('ach.lowDeathWin', 'Close Call Club'), t('ach.lowDeathWin.d', 'Win a run with three deaths or fewer.')],
  underdog: [t('ach.underdog', 'Underdog'), t('ach.underdog.d', 'Earn a badge while your strongest Pokémon is below the leader’s ace level.')],
  underdog3: [t('ach.underdog3', 'David vs. Goliath'), t('ach.underdog3.d', 'Earn {n} badges underleveled.')],
  oneHp: [t('ach.oneHp', 'Hanging by a Thread'), t('ach.oneHp.d', 'Have a Pokémon of yours survive at exactly 1 HP.')],
  veteran: [t('ach.veteran', 'Old Reliable'), t('ach.veteran.d', 'Have a Pokémon gain 40 levels after you caught it.')],
  starterSurvives: [t('ach.starterSurvives', 'Day One'), t('ach.starterSurvives.d', 'Win a run with your starter still alive.')],
  monotype: [t('ach.monotype', 'One-Type Wonder'), t('ach.monotype.d', 'Field a full team of six that shares one type – counts in runs without the type rule.')],
  byTheBook: [t('ach.byTheBook', 'By the Book'), t('ach.byTheBook.d', 'Win a Nuzlocke with level caps on – and never break one.')],
  fullTeamWin: [t('ach.fullTeamWin', 'Squad Goals'), t('ach.fullTeamWin.d', 'Win a run with a full team of six.')],
  phoenix: [t('ach.phoenix', 'Phoenix'), t('ach.phoenix.d', 'Win a run despite losing ten or more Pokémon in it.')],
  noCheatWin: [t('ach.noCheatWin', 'Honest Work'), t('ach.noCheatWin.d', 'Win a run without using a single cheat.')],
  // SoulLink
  firstLink: [t('ach.firstLink', 'Linked Souls'), t('ach.firstLink.d', 'Start your first SoulLink.')],
  soulmates: [t('ach.soulmates', 'Soulmates'), t('ach.soulmates.d', 'Play {n} SoulLinks.')],
  soulTwins: [t('ach.soulTwins', 'Soul Twins'), t('ach.soulTwins.d', 'You and your partner catch the same species on the same route.')],
  telepathy: [t('ach.telepathy', 'Telepathy'), t('ach.telepathy.d', 'Be soul twins {n} times.')],
  doubleTrouble: [t('ach.doubleTrouble', 'Double Trouble'), t('ach.doubleTrouble.d', 'Lose two links within a single turn.')],
  carried: [t('ach.carried', 'Carried'), t('ach.carried.d', 'Win a SoulLink while your partner’s strongest Pokémon is 10+ levels above yours.')],
  atlas: [t('ach.atlas', 'Atlas'), t('ach.atlas.d', 'Win a SoulLink while your strongest Pokémon is 10+ levels above your partner’s.')],
  groupLink: [t('ach.groupLink', 'The More, the Deadlier'), t('ach.groupLink.d', 'Play a SoulLink with three or four players.')],
  fellowship: [t('ach.fellowship', 'Fellowship'), t('ach.fellowship.d', 'Win a SoulLink with three or four players.')],
  jealous: [t('ach.jealous', 'Jealous'), t('ach.jealous.d', 'Your partner catches a shiny.')],
  unbreakable: [t('ach.unbreakable', 'Unbreakable Bond'), t('ach.unbreakable.d', 'Keep a link from before the first badge alive through all 8 badges.')],
  notMe: [t('ach.notMe', 'Wasn’t Me'), t('ach.notMe.d', 'The first death of a SoulLink happens on your partner’s side.')],
  tooSoon: [t('ach.tooSoon', 'Too Soon'), t('ach.tooSoon.d', 'Name a Pokémon after your partner – and lose it.')],
  // randomizer
  randoStart: [t('ach.randoStart', 'Roll the Dice'), t('ach.randoStart.d', 'Start a randomized run.')],
  rando10: [t('ach.rando10', 'Gambling Problem'), t('ach.rando10.d', 'Start {n} randomized runs.')],
  randoWin: [t('ach.randoWin', 'Chaos Tamer'), t('ach.randoWin.d', 'Win a randomized run.')],
  randoLegend: [t('ach.randoLegend', 'Route 1 Legend'), t('ach.randoLegend.d', 'Catch a legendary at level 15 or lower in a randomized run.')],
  randoDex: [t('ach.randoDex', 'Lucky Draws'), t('ach.randoDex.d', 'Catch {n} different species in randomized runs.')],
  randoHack: [t('ach.randoHack', 'Remix of a Remix'), t('ach.randoHack.d', 'Play a randomized ROM hack.')],
  vanillaWin: [t('ach.vanillaWin', 'Vanilla Flavour'), t('ach.vanillaWin.d', 'Win a run without the randomizer.')],
  bothWorlds: [t('ach.bothWorlds', 'Best of Both Worlds'), t('ach.bothWorlds.d', 'Win a randomized run and one without the randomizer.')],
  // fun
  magikarp: [t('ach.magikarp', 'It’s a Magikarp Moment'), t('ach.magikarp.d', 'Lose a Pokémon to a Magikarp.')],
  rattata: [t('ach.rattata', 'Top Percentage'), t('ach.rattata.d', 'Lose a Pokémon to a Rattata or Raticate.')],
  rival: [t('ach.rival', 'Rival Supremacy'), t('ach.rival.d', 'Lose a Pokémon to your rival’s starter before the first badge.')],
  starterDown: [t('ach.starterDown', 'Starter Not Included'), t('ach.starterDown.d', 'Lose your starter before the first badge.')],
  nuzlose: [t('ach.nuzlose', 'Nuzlocke? More Like Nuzlose'), t('ach.nuzlose.d', 'Fail {n} Nuzlockes.')],
  skillIssue: [t('ach.skillIssue', 'Skill Issue'), t('ach.skillIssue.d', 'Have a run end to a trainer’s Pokémon below level 10.')],
  bloodbath: [t('ach.bloodbath', 'Bloodbath'), t('ach.bloodbath.d', 'Lose six Pokémon before the same boss.')],
  bidoof: [t('ach.bidoof', 'Bidoof Supremacy'), t('ach.bidoof.d', 'Win a run with Bidoof or Bibarel in your final team.')],
  speedrun: [t('ach.speedrun', 'Speedrun (Any%)'), t('ach.speedrun.d', 'Fail a run within 30 minutes of starting it.')],
  cemetery: [t('ach.cemetery', 'Pokémon Tower'), t('ach.cemetery.d', 'Lose {n} Pokémon in total.')],
  lavender: [t('ach.lavender', 'Lavender Town Resident'), t('ach.lavender.d', 'Lose {n} Pokémon in total.')],
  butterfingers: [t('ach.butterfingers', 'Butterfingers'), t('ach.butterfingers.d', 'Let {n} encounters get away.')],
  tenthTime: [t('ach.tenthTime', 'Tenth Time’s the Charm'), t('ach.tenthTime.d', 'Start attempt #10 of a challenge.')],
  glowUp: [t('ach.glowUp', 'Glow Up, Fall Down'), t('ach.glowUp.d', 'Lose a Pokémon within ten minutes of it evolving.')],
  nameGame: [t('ach.nameGame', 'The Name Game'), t('ach.nameGame.d', 'Give {n} Pokémon a nickname.')],
  candyCrush: [t('ach.candyCrush', 'Candy Crush'), t('ach.candyCrush.d', 'Use {n} Rare Candies with cheats on.')],
  miltank: [t('ach.miltank', 'Rollout Trauma'), t('ach.miltank.d', 'Lose a Pokémon to a trainer’s Miltank.')],
  garchomp: [t('ach.garchomp', 'Champion’s Shadow'), t('ach.garchomp.d', 'Lose a Pokémon to a trainer’s Garchomp.')],
  kaboom: [t('ach.kaboom', 'Kaboom'), t('ach.kaboom.d', 'Lose a Pokémon to a wild Geodude, Graveler, Voltorb or Electrode.')],
  teleport: [t('ach.teleport', 'Abra Used Teleport'), t('ach.teleport.d', 'Let a wild Abra get away.')],
  roamer: [t('ach.roamer', 'It Fled!'), t('ach.roamer.d', 'Let a roaming legendary get away.')],
  shinyDown: [t('ach.shinyDown', 'Sparkle, Then Darkness'), t('ach.shinyDown.d', 'Lose a shiny Pokémon.')],
  gyarados: [t('ach.gyarados', 'Worth the Splash'), t('ach.gyarados.d', 'Evolve a Magikarp into Gyarados.')],
  feebas: [t('ach.feebas', 'Six Tiles of Patience'), t('ach.feebas.d', 'Catch a Feebas.')],
  helix: [t('ach.helix', 'Praise Helix'), t('ach.helix.d', 'Own an Omanyte or Omastar.')],
  birdJesus: [t('ach.birdJesus', 'Bird Jesus'), t('ach.birdJesus.d', 'Win a run with Pidgeot in your final team.')],
  tooMuchWater: [t('ach.tooMuchWater', 'Too Much Water'), t('ach.tooMuchWater.d', 'Catch {n} Water-type Pokémon in one Hoenn run.')],
  nightOwl: [t('ach.nightOwl', 'Night Owl'), t('ach.nightOwl.d', 'Catch a Pokémon between 3 and 5 a.m.')],
});

/** { name, desc } of an achievement – desc with its target filled in. */
export function achText(id, target) {
  const [name, desc] = ACH()[id] || [id, ''];
  return { name, desc: desc.replace('{n}', String(target ?? '')) };
}
export const achIds = () => Object.keys(ACH());

export const catLabel = (c) => ({
  journey: t('trophy.catJourney', 'Journey'), collection: t('trophy.catCollection', 'Collection'), skill: t('trophy.catSkill', 'Skill'),
  soullink: t('trophy.catSoulLink', 'SoulLink'), randomizer: t('trophy.catRandomizer', 'Randomizer'), fun: t('trophy.catFun', 'Just for fun'),
}[c] || c);

export const rarityLabel = (r) => ({
  common: t('trophy.rCommon', 'Common'), uncommon: t('trophy.rUncommon', 'Uncommon'), rare: t('trophy.rRare', 'Rare'),
  epic: t('trophy.rEpic', 'Epic'), legendary: t('trophy.rLegendary', 'Legendary'),
}[r] || r);

export const tierLabel = (tier) => ({
  bronze: t('trophy.tBronze', 'Bronze'), silver: t('trophy.tSilver', 'Silver'), gold: t('trophy.tGold', 'Gold'),
  platinum: t('trophy.tPlatinum', 'Platinum'), master: t('trophy.tMaster', 'Master'),
}[tier] || '');

/** Medal names: one per category, one per regional dex, the champion's. */
export function medalName(m) {
  if (m.kind === 'dex') return t('medal.dex', '{region} Dex Medal', { region: m.region });
  if (m.kind === 'champion') return t('medal.champion', 'Champion’s Medal');
  return {
    journey: t('medal.journey', 'Journey Medal'), collection: t('medal.collection', 'Collector’s Medal'), skill: t('medal.skill', 'Ace Medal'),
    soullink: t('medal.soullink', 'Bond Medal'), randomizer: t('medal.randomizer', 'Chaos Medal'), fun: t('medal.fun', 'Jester’s Medal'),
  }[m.cat] || m.id;
}

/** What a medal is for, in one line. */
export function medalHow(m) {
  if (m.kind === 'dex') return t('medal.dexHow', 'Catch the species of Gen {gen} (#{from}–#{to}) – event-only Pokémon excluded.', { gen: m.gen, from: m.from, to: m.to });
  if (m.kind === 'champion') return t('medal.championHow', 'Unlock achievements of every kind.');
  return t('medal.catHow', 'Unlock {cat} achievements. Master needs the secret ones too.', { cat: catLabel(m.cat) });
}
