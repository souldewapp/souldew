import com.dabomstew.pkrandom.FileFunctions;
import com.dabomstew.pkrandom.MiscTweak;
import com.dabomstew.pkrandom.Randomizer;
import com.dabomstew.pkrandom.Settings;
import com.dabomstew.pkrandom.pokemon.Encounter;
import com.dabomstew.pkrandom.pokemon.EncounterSet;
import com.dabomstew.pkrandom.pokemon.Evolution;
import com.dabomstew.pkrandom.pokemon.Pokemon;
import com.dabomstew.pkrandom.pokemon.StaticEncounter;
import com.dabomstew.pkrandom.romhandlers.Gen4RomHandler;
import com.dabomstew.pkrandom.romhandlers.RomHandler;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ResourceBundle;

/**
 * Small bridge around Universal Pokemon Randomizer ZX that adds what its CLI lacks:
 * a fixed seed (so two players can build byte-identical ROMs), settings via simple
 * key=value overrides (applied by reflection onto UPR's Settings fields) and a JSON
 * export of the randomized game data (types, evolutions, encounters) for the tracker.
 *
 * Usage:
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge info <rom>
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge fields
 *   java -cp PokeRandoZX.jar:bridge SoulLinkBridge randomize <rom> <out.nds> <settings.properties> <seed> <log.txt> <data.json>
 *
 * Compiled with --release 8 so it runs on every Java >= 8.
 */
public class SoulLinkBridge {

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("usage: info <rom> | fields | randomize <rom> <out> <settings> <seed> <log> <json>");
            System.exit(2);
        }
        try {
            if ("info".equals(args[0])) {
                info(args[1]);
            } else if ("arm9".equals(args[0])) {
                // debug: dump UPR's decompressed arm9 so code tweaks can be checked against hacks
                RomHandler h = load(args[1]);
                Field f = h.getClass().getSuperclass().getDeclaredField("arm9");
                f.setAccessible(true);
                FileOutputStream o = new FileOutputStream(args[2]);
                o.write((byte[]) f.get(h));
                o.close();
            } else if ("fields".equals(args[0])) {
                fields();
            } else if ("randomize".equals(args[0])) {
                randomize(args[1], args[2], args[3], Long.parseLong(args[4]), args[5], args[6]);
            } else {
                System.err.println("unknown command " + args[0]);
                System.exit(2);
            }
        } catch (Throwable t) {
            System.out.println("@@ERROR " + json(String.valueOf(t)));
            t.printStackTrace();
            System.exit(1);
        }
    }

    private static RomHandler load(String rom) throws Exception {
        String path = new File(rom).getAbsolutePath();
        java.util.Random random = com.dabomstew.pkrandom.RandomSource.instance();
        RomHandler handler = null;
        if (new Gen4RomHandler.Factory().isLoadable(path)) {
            handler = new SafeGen4RomHandler(random);
        } else {
            RomHandler.Factory[] factories = {
                new com.dabomstew.pkrandom.romhandlers.Gen1RomHandler.Factory(),
                new com.dabomstew.pkrandom.romhandlers.Gen2RomHandler.Factory(),
                new com.dabomstew.pkrandom.romhandlers.Gen3RomHandler.Factory(),
                new com.dabomstew.pkrandom.romhandlers.Gen5RomHandler.Factory(),
            };
            for (RomHandler.Factory f : factories) {
                if (f.isLoadable(path)) {
                    handler = f.create(random);
                    break;
                }
            }
        }
        if (handler == null) {
            throw new IllegalArgumentException("ROM is not supported by Universal Pokemon Randomizer ZX (Gen 1-5): " + path);
        }
        if (!handler.loadRom(path)) {
            throw new IllegalStateException("UPR could not load the ROM");
        }
        if (handler instanceof SafeGen4RomHandler) ((SafeGen4RomHandler) handler).probeStatics();
        return handler;
    }

    private static void info(String rom) throws Exception {
        RomHandler h = load(rom);
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"romName\":").append(json(h.getROMName())).append(',');
        sb.append("\"romCode\":").append(json(h.getROMCode())).append(',');
        sb.append("\"valid\":").append(h.isRomValid()).append(',');
        sb.append("\"generation\":").append(h.generationOfPokemon()).append(',');
        sb.append("\"pokemonCount\":").append(h.getPokemon().size() - 1).append(',');
        boolean safe4 = h instanceof SafeGen4RomHandler;
        sb.append("\"introScriptFixes\":").append(safe4 ? ((SafeGen4RomHandler) h).marillEntriesRemoved : 0).append(',');
        sb.append("\"staticsSupported\":").append(safe4 ? !((SafeGen4RomHandler) h).staticsBroken : h.canChangeStaticPokemon()).append(',');
        sb.append("\"fairyInGame\":").append(h.typeInGame(com.dabomstew.pkrandom.pokemon.Type.FAIRY)).append(',');
        int available = h.miscTweaksAvailable();
        sb.append("\"miscTweaks\":[");
        boolean first = true;
        for (MiscTweak mt : MiscTweak.allTweaks) {
            if ((available & mt.getValue()) != 0) {
                if (!first) sb.append(',');
                first = false;
                sb.append(json(tweakFieldName(mt)));
            }
        }
        sb.append("],\"starters\":[");
        first = true;
        for (Pokemon p : h.getStarters()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(json(p.fullName()));
        }
        sb.append("]}");
        System.out.println("@@JSON " + sb);
    }

    private static void fields() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Field f : Settings.class.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers())) continue;
            if (!first) sb.append(',');
            first = false;
            Class<?> t = f.getType();
            sb.append(json(f.getName())).append(":{\"type\":").append(json(t.getSimpleName()));
            if (t.isEnum()) {
                sb.append(",\"values\":[");
                Object[] cs = t.getEnumConstants();
                for (int i = 0; i < cs.length; i++) {
                    if (i > 0) sb.append(',');
                    sb.append(json(((Enum<?>) cs[i]).name()));
                }
                sb.append(']');
            }
            sb.append('}');
        }
        sb.append(",\"@miscTweaks\":{\"type\":\"list\",\"values\":[");
        first = true;
        for (MiscTweak mt : MiscTweak.allTweaks) {
            if (!first) sb.append(',');
            first = false;
            sb.append(json(tweakFieldName(mt)));
        }
        sb.append("]}}");
        System.out.println("@@JSON " + sb);
    }

    private static String tweakFieldName(MiscTweak mt) {
        for (Field f : MiscTweak.class.getFields()) {
            try {
                if (Modifier.isStatic(f.getModifiers()) && f.get(null) == mt) return f.getName();
            } catch (IllegalAccessException ignored) {
            }
        }
        return String.valueOf(mt.getValue());
    }

    private static Settings readSettings(String file) throws Exception {
        Map<String, String> props = new LinkedHashMap<String, String>();
        BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int eq = line.indexOf('=');
            if (eq < 0) continue;
            props.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
        }
        r.close();

        Settings s;
        String base = props.remove("@base");
        if (base != null && !base.isEmpty()) {
            // A settings string copied from the UPR GUI ("Settings string" in the log / Load settings).
            s = Settings.fromString(base);
        } else {
            s = new Settings();
            fillDefaults(s);
        }
        String tweaks = props.remove("@miscTweaks");
        if (tweaks != null) {
            int value = 0;
            for (String name : tweaks.split(",")) {
                name = name.trim();
                if (name.isEmpty()) continue;
                Field f = MiscTweak.class.getField(name);
                value |= ((MiscTweak) f.get(null)).getValue();
            }
            s.setCurrentMiscTweaks(value);
        }
        for (Map.Entry<String, String> e : props.entrySet()) {
            Field f;
            try {
                f = Settings.class.getDeclaredField(e.getKey());
            } catch (NoSuchFieldException ex) {
                System.out.println("@@WARN " + json("Unknown setting ignored: " + e.getKey()));
                continue;
            }
            f.setAccessible(true);
            Class<?> t = f.getType();
            String v = e.getValue();
            if (t == boolean.class) {
                f.setBoolean(s, Boolean.parseBoolean(v));
            } else if (t == int.class) {
                f.setInt(s, Integer.parseInt(v));
            } else if (t == int[].class) {
                String[] parts = v.split(",");
                int[] arr = new int[parts.length];
                for (int i = 0; i < parts.length; i++) arr[i] = Integer.parseInt(parts[i].trim());
                f.set(s, arr);
            } else if (t == String.class) {
                f.set(s, v);
            } else if (t.isEnum()) {
                f.set(s, enumValue(t, v));
            } else {
                System.out.println("@@WARN " + json("Unsupported setting type for " + e.getKey()));
            }
        }
        return s;
    }

    /** A bare `new Settings()` leaves fields null that toString()/randomize() dereference. */
    private static void fillDefaults(Settings s) throws Exception {
        for (Field f : Settings.class.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers())) continue;
            f.setAccessible(true);
            if (f.get(s) != null) continue;
            Class<?> t = f.getType();
            if (t.isEnum()) {
                f.set(s, t.getEnumConstants()[0]);
            } else if (t == int[].class) {
                f.set(s, new int[]{0, 0, 0});
            } else if (t == String.class) {
                f.set(s, "");
            } else if (t == com.dabomstew.pkrandom.pokemon.GenRestrictions.class) {
                f.set(s, new com.dabomstew.pkrandom.pokemon.GenRestrictions());
            }
        }
        Field curve = Settings.class.getDeclaredField("selectedEXPCurve");
        curve.setAccessible(true);
        curve.set(s, com.dabomstew.pkrandom.pokemon.ExpCurve.MEDIUM_FAST);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object enumValue(Class<?> t, String v) {
        return Enum.valueOf((Class) t, v);
    }

    private static void randomize(String rom, String out, String settingsFile, long seed, String logFile, String jsonFile) throws Exception {
        Settings settings = readSettings(settingsFile);
        settings.setCustomNames(FileFunctions.getCustomNames());
        RomHandler h = load(rom);
        settings.setRomName(h.getROMName());
        if (h instanceof SafeGen4RomHandler && ((SafeGen4RomHandler) h).staticsBroken && settings.getStaticPokemonMod() != Settings.StaticPokemonMod.UNCHANGED) {
            Field f = Settings.class.getDeclaredField("staticPokemonMod");
            f.setAccessible(true);
            f.set(settings, Settings.StaticPokemonMod.UNCHANGED);
            System.out.println("@@WARN " + json("Static Pokemon cannot be randomized in this ROM hack (scripts differ from vanilla) - left unchanged"));
        }
        Settings.TweakForROMFeedback fb = settings.tweakForRom(h);
        if (fb.isChangedStarter()) System.out.println("@@WARN " + json("Custom starters were adjusted for this ROM"));
        if (fb.isRemovedCodeTweaks()) System.out.println("@@WARN " + json("Some code tweaks are not supported by this ROM and were removed"));
        System.out.println("@@SETTINGS " + json(settings.toString()));

        ResourceBundle bundle = ResourceBundle.getBundle("com/dabomstew/pkrandom/newgui/Bundle");
        ByteArrayOutputStream logBytes = new ByteArrayOutputStream();
        PrintStream log = new PrintStream(logBytes, true, "UTF-8");
        int check = new Randomizer(settings, h, bundle, false).randomize(new File(out).getAbsolutePath(), log, seed);
        log.close();
        FileOutputStream lf = new FileOutputStream(logFile);
        lf.write(logBytes.toByteArray());
        lf.close();

        Writer w = new OutputStreamWriter(new FileOutputStream(jsonFile), StandardCharsets.UTF_8);
        w.write(exportData(h, settings, seed, check));
        w.close();
        System.out.println("@@DONE " + json(String.valueOf(check)));
    }

    private static String exportData(RomHandler h, Settings settings, long seed, int check) {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"seed\":").append(json(String.valueOf(seed))).append(',');
        sb.append("\"checkValue\":").append(check).append(',');
        sb.append("\"settingsString\":").append(json(settings.toString())).append(',');
        sb.append("\"romName\":").append(json(h.getROMName())).append(',');
        sb.append("\"pokemon\":[");
        List<Pokemon> list = h.getPokemonInclFormes();
        boolean first = true;
        for (Pokemon p : list) {
            if (p == null) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"id\":").append(p.number)
              .append(",\"name\":").append(json(p.fullName()))
              .append(",\"forme\":").append(p.formeNumber)
              .append(",\"types\":[").append(json(p.primaryType == null ? null : p.primaryType.name()));
            if (p.secondaryType != null) sb.append(',').append(json(p.secondaryType.name()));
            sb.append("],\"stats\":[").append(p.hp).append(',').append(p.attack).append(',').append(p.defense)
              .append(',').append(p.spatk).append(',').append(p.spdef).append(',').append(p.speed).append(']')
              .append(",\"abilities\":[").append(json(h.abilityName(p.ability1))).append(',')
              .append(json(h.abilityName(p.ability2))).append(',').append(json(p.ability3 > 0 ? h.abilityName(p.ability3) : "")).append(']')
              .append(",\"catchRate\":").append(p.catchRate)
              .append(",\"evolvesTo\":[");
            boolean f2 = true;
            for (Evolution e : p.evolutionsFrom) {
                if (!f2) sb.append(',');
                f2 = false;
                sb.append("{\"to\":").append(e.to.number).append(",\"method\":").append(json(e.type.name()))
                  .append(",\"param\":").append(e.extraInfo).append('}');
            }
            sb.append("],\"evolvesFrom\":[");
            f2 = true;
            for (Evolution e : p.evolutionsTo) {
                if (!f2) sb.append(',');
                f2 = false;
                sb.append(e.from.number);
            }
            sb.append("]}");
        }
        sb.append("],\"starters\":[");
        first = true;
        for (Pokemon p : h.getStarters()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(p.number);
        }
        sb.append("],\"encounters\":[");
        first = true;
        List<EncounterSet> sets = new ArrayList<EncounterSet>();
        try {
            sets = h.getEncounters(true);
        } catch (Exception ignored) {
        }
        for (EncounterSet es : sets) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"area\":").append(json(es.displayName)).append(",\"rate\":").append(es.rate).append(",\"slots\":[");
            boolean f2 = true;
            for (Encounter enc : es.encounters) {
                if (enc.pokemon == null) continue;
                if (!f2) sb.append(',');
                f2 = false;
                sb.append('[').append(enc.pokemon.number).append(',').append(enc.level).append(',')
                  .append(Math.max(enc.level, enc.maxLevel)).append(']');
            }
            sb.append("]}");
        }
        sb.append("],\"statics\":[");
        first = true;
        List<StaticEncounter> statics = new ArrayList<StaticEncounter>();
        try {
            statics = h.getStaticPokemon();
        } catch (Exception ignored) {
        }
        for (StaticEncounter se : statics) {
            if (se.pkmn == null) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append('[').append(se.pkmn.number).append(',').append(se.level).append(']');
        }
        sb.append("]}");
        return sb.toString();
    }

    /**
     * ROM hacks rewrite event scripts, so UPR's hardcoded static-encounter script offsets can point
     * past the end of a file (Definitive HeartGold does this). Reading them then throws, and
     * Randomizer.randomize() always reads them. We detect that once and treat statics as unavailable.
     */
    static class SafeGen4RomHandler extends Gen4RomHandler {
        boolean staticsBroken;

        SafeGen4RomHandler(java.util.Random random) {
            super(random);
        }

        int marillEntriesRemoved;

        void probeStatics() {
            try {
                super.getStaticPokemon();
            } catch (RuntimeException e) {
                staticsBroken = true;
            }
            sanitizeMarillCryScripts();
        }

        /**
         * randomizeIntroPokemon() always rewrites Marill's cry id at hardcoded script offsets.
         * In hacks some of those offsets now hold other script bytes, so only keep entries that
         * really contain Marill (#183) — everything else would be silently corrupted.
         */
        @SuppressWarnings("unchecked")
        void sanitizeMarillCryScripts() {
            try {
                Field entryField = Gen4RomHandler.class.getDeclaredField("romEntry");
                entryField.setAccessible(true);
                Object entry = entryField.get(this);
                Field listField = entry.getClass().getDeclaredField("marillCryScriptEntries");
                listField.setAccessible(true);
                List<Object> list = (List<Object>) listField.get(entry);
                Field narcField = Gen4RomHandler.class.getDeclaredField("scriptNarc");
                narcField.setAccessible(true);
                com.dabomstew.pkrandom.newnds.NARCArchive narc = (com.dabomstew.pkrandom.newnds.NARCArchive) narcField.get(this);
                if (list == null || narc == null) return;
                java.util.Iterator<Object> it = list.iterator();
                while (it.hasNext()) {
                    Object se = it.next();
                    Field ff = se.getClass().getDeclaredField("scriptFile");
                    Field fo = se.getClass().getDeclaredField("scriptOffset");
                    ff.setAccessible(true);
                    fo.setAccessible(true);
                    int file = ff.getInt(se);
                    int off = fo.getInt(se);
                    byte[] data = file < narc.files.size() ? narc.files.get(file) : null;
                    boolean ok = data != null && off + 1 < data.length
                            && ((data[off] & 0xFF) | ((data[off + 1] & 0xFF) << 8)) == 183;
                    if (!ok) {
                        it.remove();
                        marillEntriesRemoved++;
                    }
                }
            } catch (Exception e) {
                System.out.println("@@WARN " + json("Could not validate intro script offsets: " + e));
            }
        }

        @Override
        public List<StaticEncounter> getStaticPokemon() {
            if (staticsBroken) return new ArrayList<StaticEncounter>();
            return super.getStaticPokemon();
        }

        @Override
        public boolean setStaticPokemon(List<StaticEncounter> statics) {
            if (staticsBroken) return true;
            return super.setStaticPokemon(statics);
        }

        @Override
        public boolean canChangeStaticPokemon() {
            return !staticsBroken && super.canChangeStaticPokemon();
        }
    }

    private static String json(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
