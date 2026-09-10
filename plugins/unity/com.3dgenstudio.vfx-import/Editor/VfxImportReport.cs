// What an import did, approximated, and could not do.
//
// THE PLAN IS EXPLICIT THAT THIS IS NOT OPTIONAL: "half-importing a bundle you
// do not fully understand produces an effect that looks nearly right, which is
// worse than an error." Compatibility is already surfaced at AUTHOR time - every
// block carries engine flags in the editor and setting a target raises a
// diagnostic - so an import should CONFIRM what the author already saw and
// never surprise them.
//
// Three severities, and the distinction is the point:
//
//   Native       - carried across exactly. Listed so a clean import is visibly
//                  clean rather than merely silent.
//   Approximated - carried across with a different mechanism and a different
//                  result. The author gets the name of the block and what it
//                  became, because "your vortex is now an orbital velocity" is
//                  actionable and "some things changed" is not.
//   Dropped      - no mechanism at all. Named, always.
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace GenStudio3D.VfxImport
{
    public enum VfxFidelity { Native, Approximated, Dropped }

    public sealed class VfxImportNote
    {
        public VfxFidelity Fidelity;
        public string System;
        public string Feature;
        public string Detail;
    }

    public sealed class VfxImportReport
    {
        public readonly List<VfxImportNote> Notes = new List<VfxImportNote>();
        public readonly List<string> Errors = new List<string>();

        public void Native(string system, string feature, string detail = null) =>
            Notes.Add(new VfxImportNote
            {
                Fidelity = VfxFidelity.Native, System = system, Feature = feature, Detail = detail,
            });

        public void Approximated(string system, string feature, string detail) =>
            Notes.Add(new VfxImportNote
            {
                Fidelity = VfxFidelity.Approximated, System = system, Feature = feature, Detail = detail,
            });

        public void Dropped(string system, string feature, string detail) =>
            Notes.Add(new VfxImportNote
            {
                Fidelity = VfxFidelity.Dropped, System = system, Feature = feature, Detail = detail,
            });

        public void Error(string message) => Errors.Add(message);

        public bool Failed => Errors.Count > 0;

        public int CountOf(VfxFidelity fidelity) => Notes.Count(note => note.Fidelity == fidelity);

        /// <summary>
        /// A summary line. Deliberately states the native count too: "23 native"
        /// is the number that tells an author the import went well, and a report
        /// that only ever lists problems trains them to dread it.
        /// </summary>
        public string Summary()
        {
            if (Failed) return $"Import failed: {string.Join(" ", Errors)}";
            var approximated = CountOf(VfxFidelity.Approximated);
            var dropped = CountOf(VfxFidelity.Dropped);
            var summary = $"{CountOf(VfxFidelity.Native)} native";
            if (approximated > 0) summary += $", {approximated} approximated";
            if (dropped > 0) summary += $", {dropped} dropped";
            return summary;
        }

        public string ToText()
        {
            var sb = new StringBuilder();
            sb.AppendLine(Summary());
            foreach (var error in Errors) sb.AppendLine("  ERROR        " + error);

            // Problems first: an author scanning this wants what changed, and
            // the native list is reference material below it.
            foreach (var fidelity in new[] { VfxFidelity.Dropped, VfxFidelity.Approximated, VfxFidelity.Native })
            {
                var group = Notes.Where(note => note.Fidelity == fidelity).ToList();
                if (group.Count == 0) continue;
                sb.AppendLine();
                sb.AppendLine(fidelity.ToString().ToUpperInvariant());
                foreach (var note in group)
                {
                    sb.Append("  ")
                      .Append((note.System ?? "effect").PadRight(16))
                      .Append(note.Feature.PadRight(30));
                    // A name longer than the column still needs a gap, or an
                    // asset filename runs straight into its explanation.
                    if (!string.IsNullOrEmpty(note.Detail)) sb.Append(' ').Append(note.Detail);
                    sb.AppendLine();
                }
            }
            return sb.ToString();
        }
    }
}
