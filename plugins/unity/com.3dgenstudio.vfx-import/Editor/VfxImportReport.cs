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

        /// <summary>
        /// Things the SCENE has to provide that no prefab can carry.
        ///
        /// A FOURTH CATEGORY because the other three are all about the import,
        /// and this is not: the effect arrived intact and still looks wrong
        /// until something outside it changes. The case that forced it is tone
        /// mapping - the app previews through ACES Filmic, so an author tunes a
        /// core at 16x intensity knowing it will roll off, and URP's default
        /// volume profile ships with Tonemapping set to None, which clips that
        /// same core to a flat white slab. Filed as "approximated" it read as
        /// import damage and sent people editing gradients; it belongs at the
        /// top of the report, stated once, as a thing to go and switch on.
        ///
        /// Deduplicated on the way in: every system with an HDR gradient wants
        /// to say the same sentence, and six copies of it is noise.
        /// </summary>
        public readonly List<string> SceneRequirements = new List<string>();

        public void SceneRequirement(string requirement)
        {
            if (!SceneRequirements.Contains(requirement)) SceneRequirements.Add(requirement);
        }

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

        /// <summary>
        /// One report column: padded out to `width`, and when the value is
        /// longer than that, kept whole with a single space after it so the
        /// next column never butts up against it.
        /// </summary>
        private static string Column(string value, int width)
        {
            value ??= string.Empty;
            return value.Length >= width ? value + " " : value.PadRight(width);
        }

        public string ToText()
        {
            var sb = new StringBuilder();
            sb.AppendLine(Summary());
            foreach (var error in Errors) sb.AppendLine("  ERROR        " + error);

            if (SceneRequirements.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("THE SCENE HAS TO PROVIDE");
                foreach (var requirement in SceneRequirements) sb.AppendLine("  - " + requirement);
            }

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
                      // PadRight does NOT truncate, so a system name longer than
                      // the column ran straight into the feature with no gap:
                      // "00 Sphere-Surface + VelRandominitialize.velocityRandom".
                      // The report is the first thing anyone reads when an
                      // import looks wrong, so it has to stay in columns.
                      .Append(Column(note.System ?? "effect", 16))
                      .Append(Column(note.Feature, 30));
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
