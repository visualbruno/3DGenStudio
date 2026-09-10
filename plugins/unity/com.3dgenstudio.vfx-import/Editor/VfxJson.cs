// A minimal JSON reader for the VFX bundle.
//
// WHY NOT JsonUtility. Unity's built-in serialiser cannot represent the IR:
// `modes` is an open string map, a binding is polymorphic on `src` with a
// different field set per case, and the whole document carries fields this
// importer deliberately ignores. JsonUtility needs a concrete [Serializable]
// class per shape and silently drops what it has no field for - which for an
// importer means an effect that looks nearly right, the worst outcome.
//
// So: parse to a dynamic tree and read what we understand. Roughly 200 lines,
// no dependency, and it tolerates an IR from a newer app version gaining fields
// - which it will.
//
// It is deliberately NOT a general-purpose JSON library. No comments, no
// trailing commas, no big-integer handling. It reads what our exporter writes.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace GenStudio3D.VfxImport
{
    /// <summary>A parsed JSON value: object, array, string, number, bool or null.</summary>
    public sealed class VfxJson
    {
        private readonly Dictionary<string, VfxJson> _object;
        private readonly List<VfxJson> _array;
        private readonly string _string;
        private readonly double _number;
        private readonly bool _bool;
        private readonly Kind _kind;

        private enum Kind { Null, Object, Array, String, Number, Bool }

        private VfxJson(Kind kind)
        {
            _kind = kind;
            if (kind == Kind.Object) _object = new Dictionary<string, VfxJson>();
            if (kind == Kind.Array) _array = new List<VfxJson>();
        }

        private VfxJson(string value) { _kind = Kind.String; _string = value; }
        private VfxJson(double value) { _kind = Kind.Number; _number = value; }
        private VfxJson(bool value) { _kind = Kind.Bool; _bool = value; }

        public static readonly VfxJson Null = new VfxJson(Kind.Null);

        public bool IsNull => _kind == Kind.Null;
        public bool IsObject => _kind == Kind.Object;
        public bool IsArray => _kind == Kind.Array;
        public int Count => _array?.Count ?? 0;

        /// <summary>
        /// A member, or <see cref="Null"/> when absent.
        ///
        /// NEVER THROWS ON A MISSING KEY, on purpose: an importer reads dozens
        /// of optional fields, and `ir["effect"]["prewarm"].AsFloat(0)` reading
        /// cleanly whether or not prewarm exists is what keeps the call sites
        /// legible. A field whose ABSENCE is a problem is checked explicitly.
        /// </summary>
        public VfxJson this[string key] =>
            _object != null && _object.TryGetValue(key, out var value) ? value : Null;

        public VfxJson this[int index] =>
            _array != null && index >= 0 && index < _array.Count ? _array[index] : Null;

        public IEnumerable<VfxJson> Items => _array ?? (IEnumerable<VfxJson>)Array.Empty<VfxJson>();

        public IEnumerable<KeyValuePair<string, VfxJson>> Members =>
            _object ?? (IEnumerable<KeyValuePair<string, VfxJson>>)Array.Empty<KeyValuePair<string, VfxJson>>();

        public bool Has(string key) => _object != null && _object.ContainsKey(key);

        public string AsString(string fallback = "") =>
            _kind == Kind.String ? _string
            : _kind == Kind.Number ? _number.ToString(CultureInfo.InvariantCulture)
            : fallback;

        public float AsFloat(float fallback = 0f) =>
            _kind == Kind.Number ? (float)_number
            : _kind == Kind.Bool ? (_bool ? 1f : 0f)
            : fallback;

        public int AsInt(int fallback = 0) =>
            _kind == Kind.Number ? (int)Math.Round(_number) : fallback;

        public bool AsBool(bool fallback = false) =>
            _kind == Kind.Bool ? _bool
            : _kind == Kind.Number ? _number != 0
            : fallback;

        /// <summary>An array of numbers, for the IR's vec3s and tables.</summary>
        public float[] AsFloats()
        {
            if (_array == null) return Array.Empty<float>();
            var result = new float[_array.Count];
            for (var i = 0; i < _array.Count; i++) result[i] = _array[i].AsFloat();
            return result;
        }

        // --- parsing ---------------------------------------------------------

        public static VfxJson Parse(string text)
        {
            var at = 0;
            var value = ParseValue(text, ref at);
            SkipWhitespace(text, ref at);
            if (at < text.Length)
            {
                throw new FormatException($"Unexpected trailing content at {at}.");
            }
            return value;
        }

        private static VfxJson ParseValue(string s, ref int at)
        {
            SkipWhitespace(s, ref at);
            if (at >= s.Length) throw new FormatException("Unexpected end of JSON.");

            switch (s[at])
            {
                case '{': return ParseObject(s, ref at);
                case '[': return ParseArray(s, ref at);
                case '"': return new VfxJson(ParseString(s, ref at));
                case 't': Expect(s, ref at, "true"); return new VfxJson(true);
                case 'f': Expect(s, ref at, "false"); return new VfxJson(false);
                case 'n': Expect(s, ref at, "null"); return Null;
                default: return new VfxJson(ParseNumber(s, ref at));
            }
        }

        private static VfxJson ParseObject(string s, ref int at)
        {
            var result = new VfxJson(Kind.Object);
            at++; // '{'
            SkipWhitespace(s, ref at);
            if (at < s.Length && s[at] == '}') { at++; return result; }
            while (true)
            {
                SkipWhitespace(s, ref at);
                var key = ParseString(s, ref at);
                SkipWhitespace(s, ref at);
                if (at >= s.Length || s[at] != ':') throw new FormatException($"Expected ':' at {at}.");
                at++;
                result._object[key] = ParseValue(s, ref at);
                SkipWhitespace(s, ref at);
                if (at >= s.Length) throw new FormatException("Unterminated object.");
                if (s[at] == ',') { at++; continue; }
                if (s[at] == '}') { at++; return result; }
                throw new FormatException($"Expected ',' or '}}' at {at}.");
            }
        }

        private static VfxJson ParseArray(string s, ref int at)
        {
            var result = new VfxJson(Kind.Array);
            at++; // '['
            SkipWhitespace(s, ref at);
            if (at < s.Length && s[at] == ']') { at++; return result; }
            while (true)
            {
                result._array.Add(ParseValue(s, ref at));
                SkipWhitespace(s, ref at);
                if (at >= s.Length) throw new FormatException("Unterminated array.");
                if (s[at] == ',') { at++; continue; }
                if (s[at] == ']') { at++; return result; }
                throw new FormatException($"Expected ',' or ']' at {at}.");
            }
        }

        private static string ParseString(string s, ref int at)
        {
            if (at >= s.Length || s[at] != '"') throw new FormatException($"Expected a string at {at}.");
            at++;
            var sb = new StringBuilder();
            while (at < s.Length)
            {
                var c = s[at++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (at >= s.Length) break;
                var escape = s[at++];
                switch (escape)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (at + 4 > s.Length) throw new FormatException("Truncated \\u escape.");
                        sb.Append((char)Convert.ToInt32(s.Substring(at, 4), 16));
                        at += 4;
                        break;
                    default: throw new FormatException($"Unknown escape \\{escape}.");
                }
            }
            throw new FormatException("Unterminated string.");
        }

        private static double ParseNumber(string s, ref int at)
        {
            var start = at;
            if (at < s.Length && (s[at] == '-' || s[at] == '+')) at++;
            while (at < s.Length && (char.IsDigit(s[at]) || s[at] == '.' || s[at] == 'e' || s[at] == 'E'
                                     || s[at] == '-' || s[at] == '+')) at++;
            var slice = s.Substring(start, at - start);
            // InvariantCulture, without exception: a French or German editor
            // locale reads "0.5" as 5 with a comma-decimal parse, which would
            // scale an effect by ten and look like a bug in the exporter.
            if (!double.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            {
                throw new FormatException($"Bad number \"{slice}\" at {start}.");
            }
            return value;
        }

        private static void Expect(string s, ref int at, string literal)
        {
            if (at + literal.Length > s.Length || string.CompareOrdinal(s, at, literal, 0, literal.Length) != 0)
            {
                throw new FormatException($"Expected \"{literal}\" at {at}.");
            }
            at += literal.Length;
        }

        private static void SkipWhitespace(string s, ref int at)
        {
            while (at < s.Length && (s[at] == ' ' || s[at] == '\t' || s[at] == '\n' || s[at] == '\r')) at++;
        }
    }
}
