// Reading the VFX IR, and converting it into Unreal's world.
//
// READS `srcBlockType`, NOT `kernel`, for the same reason the Unity importer
// does: the kernel is the lowered form the app's own runtime dispatches, and
// srcBlockType is the block the author actually placed. Mapping from the
// authored type is what lets the report say "your Point Attractor became a
// Point Attraction Force" instead of guessing at a lowered kernel's intent.
//
// SPACE. The IR is right-handed, Y-up, in metres (VFX_IR_SPACE in vfx/ir.js).
// Unreal is left-handed, Z-up, in centimetres. So every position, offset, size
// and speed goes through FVfxConvert - never a raw copy. The conversion is
//
//     UE = (ir.x, ir.z, ir.y) * 100
//
// which swaps two axes, and therefore flips handedness exactly once, and scales
// metres to centimetres. A vector that skips this is not subtly wrong: it is a
// hundred times too small and lying on its side.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * One resolved block property.
 *
 * The IR stores properties as BINDINGS into a shared constant pool rather than
 * as inline values, because the compiler content-addresses and dedupes them.
 * So reading a property is a lookup, not a field access, and a property the
 * author never touched has no binding at all - which is why bFound exists and
 * why a caller must not treat a zero as "the author asked for zero".
 */
struct FVfxBound
{
	bool bFound = false;

	/** Scalar value, or the mid-point of a random range. */
	float Constant = 0.f;

	/** Up to four components, already in IR space - convert before use. */
	float Vector[4] = { 0.f, 0.f, 0.f, 0.f };

	int32 Width = 1;

	/** A random-between-two-constants property. */
	bool bRandom = false;
	float Low = 0.f;
	float High = 0.f;
	float LowVector[4] = { 0.f, 0.f, 0.f, 0.f };
	float HighVector[4] = { 0.f, 0.f, 0.f, 0.f };

	/** The AUTHORED curve or gradient, not the baked table - see FVfxIr. */
	TSharedPtr<FJsonObject> Curve;
	TSharedPtr<FJsonObject> Gradient;
	float Scale = 1.f;

	bool IsCurve() const { return Curve.IsValid(); }
	bool IsGradient() const { return Gradient.IsValid(); }
};

/** Axis and unit conversion. Nothing crosses into Unreal without passing here. */
struct FVfxConvert
{
	/** Metres, right-handed Y-up -> centimetres, left-handed Z-up. */
	static FVector3f Vector(const float* Xyz)
	{
		return FVector3f(Xyz[0], Xyz[2], Xyz[1]) * 100.f;
	}

	/** A direction, with no unit scaling - it is already dimensionless. */
	static FVector3f Direction(const float* Xyz)
	{
		return FVector3f(Xyz[0], Xyz[2], Xyz[1]);
	}

	/** A length or a speed: metres (per second) -> centimetres (per second). */
	static float Length(float Metres) { return Metres * 100.f; }

	/**
	 * Euler degrees.
	 *
	 * A ROTATION IS NOT A VECTOR. Swapping two axes mirrors the space, which
	 * reverses the sense of rotation about the axes lying IN the mirror plane
	 * and leaves the perpendicular one alone. Copying the components the way a
	 * position is copied tilts every rotated emitter the wrong way, and it looks
	 * like an authoring mistake rather than an importer bug.
	 */
	static FVector3f Euler(const float* Xyz)
	{
		return FVector3f(-Xyz[0], -Xyz[2], Xyz[1]);
	}

	/**
	 * Colour, KEEPING VALUES ABOVE 1.
	 *
	 * The gradient editor stores linear HDR, because an additive core needs to
	 * be brighter than white to read as hot. Unreal's FLinearColor is happy to
	 * hold that and its materials are happy to render it, so unlike the Unity
	 * side - where Gradient is LDR and the intensity has to be folded away with
	 * an apology - nothing is lost here.
	 */
	static FLinearColor Colour(const float* Rgba, int32 InWidth)
	{
		return FLinearColor(Rgba[0], Rgba[1], InWidth > 2 ? Rgba[2] : 0.f,
			InWidth > 3 ? Rgba[3] : 1.f);
	}

	/** "#rrggbb" times an intensity, linear, may exceed 1. */
	static FLinearColor FromHex(const FString& Hex, float Intensity);
};

/**
 * The manifest, plus the lookups that make the IR readable.
 *
 * Holds no Niagara types on purpose: this is the half that can be reasoned
 * about - and, where it matters, tested - without an editor.
 */
class FVfxIr
{
public:
	/** Parse a bundle manifest. Returns false and fills OutError on failure. */
	bool LoadFromFile(const FString& ManifestPath, FString& OutError);

	const TSharedPtr<FJsonObject>& Manifest() const { return Root; }
	const TSharedPtr<FJsonObject>& Ir() const { return IrObject; }

	/** The effect name, for the asset. Falls back to the bundle folder name. */
	FString EffectName(const FString& Fallback) const;

	const TArray<TSharedPtr<FJsonValue>>& Systems() const;

	/** Resolve one property of one IR block. */
	FVfxBound Binding(const TSharedPtr<FJsonObject>& Block, const TCHAR* Prop) const;

	/** A block's ordered point list - the curve emitter's path. Empty if none. */
	TArray<FVector3f> Points(const TSharedPtr<FJsonObject>& Block) const;

	float Constant(int32 Index) const;

	static FString BlockType(const TSharedPtr<FJsonObject>& Block);
	static FString Mode(const TSharedPtr<FJsonObject>& Block, const TCHAR* Name,
		const TCHAR* Fallback);

	/** `effect` settings. */
	float Duration() const;
	bool Loops() const;
	int32 Seed() const;

private:
	TSharedPtr<FJsonObject> Root;
	TSharedPtr<FJsonObject> IrObject;
	TArray<TSharedPtr<FJsonValue>> ConstantPool;
	TArray<TSharedPtr<FJsonValue>> TablePool;
	TArray<TSharedPtr<FJsonValue>> SystemList;
};
