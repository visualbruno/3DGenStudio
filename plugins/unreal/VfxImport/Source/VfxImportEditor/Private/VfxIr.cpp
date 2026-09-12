#include "VfxIr.h"

#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

FLinearColor FVfxConvert::FromHex(const FString& Hex, float Intensity)
{
	// Authored as sRGB hex, because that is what a colour picker speaks, but
	// the gradient the runtime samples is LINEAR - so the conversion has to
	// happen here rather than being skipped as "it is only a colour". Skipping
	// it makes every ramp visibly too bright in the mid-tones, which reads as
	// the importer having the wrong gamma rather than the wrong maths.
	const FColor Srgb = FColor::FromHex(Hex.StartsWith(TEXT("#")) ? Hex : TEXT("#") + Hex);
	FLinearColor Linear = FLinearColor::FromSRGBColor(Srgb);
	Linear.R *= Intensity;
	Linear.G *= Intensity;
	Linear.B *= Intensity;
	Linear.A = 1.f;
	return Linear;
}

bool FVfxIr::LoadFromFile(const FString& ManifestPath, FString& OutError)
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *ManifestPath))
	{
		OutError = FString::Printf(TEXT("could not read %s"), *ManifestPath);
		return false;
	}

	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		OutError = FString::Printf(TEXT("%s is not valid JSON"), *ManifestPath);
		return false;
	}

	IrObject = Root->GetObjectField(TEXT("ir"));
	if (!IrObject.IsValid())
	{
		// The bundle carries the authoring graph too, but a plugin must not read
		// it: the IR is what the compiler produces AFTER operator sorting,
		// frequency classification and curve baking, and reading the graph here
		// would mean reimplementing that compiler in C++ - and disagreeing with
		// both the preview and the Unity importer about the same effect.
		OutError = TEXT("the manifest has no `ir` - is this a VFX export bundle?");
		return false;
	}

	const TArray<TSharedPtr<FJsonValue>>* Found = nullptr;
	if (IrObject->TryGetArrayField(TEXT("constants"), Found)) { ConstantPool = *Found; }
	if (IrObject->TryGetArrayField(TEXT("tables"), Found)) { TablePool = *Found; }
	if (IrObject->TryGetArrayField(TEXT("systems"), Found)) { SystemList = *Found; }

	if (SystemList.Num() == 0)
	{
		OutError = TEXT("the effect has no systems");
		return false;
	}
	return true;
}

FString FVfxIr::EffectName(const FString& Fallback) const
{
	const TSharedPtr<FJsonObject>* Asset = nullptr;
	if (Root.IsValid() && Root->TryGetObjectField(TEXT("asset"), Asset))
	{
		const FString Name = (*Asset)->GetStringField(TEXT("name"));
		if (!Name.IsEmpty()) { return Name; }
	}
	return Fallback;
}

const TArray<TSharedPtr<FJsonValue>>& FVfxIr::Systems() const
{
	return SystemList;
}

float FVfxIr::Constant(int32 Index) const
{
	return ConstantPool.IsValidIndex(Index)
		? static_cast<float>(ConstantPool[Index]->AsNumber())
		: 0.f;
}

namespace
{
	void ReadVector(const TArray<TSharedPtr<FJsonValue>>& Pool, int32 At, int32 Width,
		float* Out)
	{
		for (int32 i = 0; i < Width && i < 4; ++i)
		{
			const int32 Index = At + i;
			Out[i] = Pool.IsValidIndex(Index)
				? static_cast<float>(Pool[Index]->AsNumber()) : 0.f;
		}
	}
}

namespace
{
	/**
	 * Run one operator chain at one effect time.
	 *
	 * MIRRORS OP_EVALUATORS IN THE APP, including its edge cases, because a
	 * near-miss here is worse than nothing: remap CLAMPS rather than
	 * extrapolating, divide by ~zero yields zero rather than infinity, sine is
	 * sin(x * 2pi) rather than sin(x), and `random` flattens to the middle of
	 * its range because per-frame noise has no static value at all.
	 */
	float EvaluateOps(const TArray<TSharedPtr<FJsonValue>>& Ops, int32 Register, float Time,
		const TFunctionRef<float(int32)>& Constant)
	{
		TMap<int32, float> Registers;
		for (const TSharedPtr<FJsonValue>& Entry : Ops)
		{
			const TSharedPtr<FJsonObject> Op = Entry->AsObject();
			if (!Op.IsValid()) { continue; }

			TArray<float> In;
			const TArray<TSharedPtr<FJsonValue>>* Inputs = nullptr;
			if (Op->TryGetArrayField(TEXT("in"), Inputs))
			{
				for (const TSharedPtr<FJsonValue>& InputEntry : *Inputs)
				{
					const TSharedPtr<FJsonObject> Input = InputEntry->AsObject();
					if (!Input.IsValid()) { In.Add(0.f); continue; }
					const int32 Index = Input->GetIntegerField(TEXT("index"));
					if (Input->GetStringField(TEXT("kind")) == TEXT("register"))
					{
						const float* Upstream = Registers.Find(Index);
						In.Add(Upstream != nullptr ? *Upstream : 0.f);
					}
					else
					{
						In.Add(Constant(Index));
					}
				}
			}
			auto At = [&In](int32 i) { return In.IsValidIndex(i) ? In[i] : 0.f; };

			const FString Kind = Op->GetStringField(TEXT("op"));
			float Value = 0.f;
			if (Kind == TEXT("time")) { Value = Time; }
			else if (Kind == TEXT("const")) { Value = At(0); }
			else if (Kind == TEXT("add")) { Value = At(0) + At(1); }
			else if (Kind == TEXT("sub")) { Value = At(0) - At(1); }
			else if (Kind == TEXT("mul")) { Value = At(0) * At(1); }
			else if (Kind == TEXT("div"))
			{
				Value = FMath::Abs(At(1)) < 1e-9f ? 0.f : At(0) / At(1);
			}
			else if (Kind == TEXT("lerp")) { Value = At(0) + (At(1) - At(0)) * At(2); }
			else if (Kind == TEXT("clamp")) { Value = FMath::Clamp(At(0), At(1), At(2)); }
			else if (Kind == TEXT("sin")) { Value = FMath::Sin(At(0) * 2.f * PI); }
			else if (Kind == TEXT("random")) { Value = (At(0) + At(1)) * 0.5f; }
			else if (Kind == TEXT("remap"))
			{
				const float Span = At(2) - At(1);
				if (FMath::Abs(Span) < 1e-9f) { Value = At(3); }
				else
				{
					const float K = FMath::Clamp((At(0) - At(1)) / Span, 0.f, 1.f);
					Value = At(3) + (At(4) - At(3)) * K;
				}
			}
			Registers.Add(Op->GetIntegerField(TEXT("out")), Value);
		}
		const float* Result = Registers.Find(Register);
		return Result != nullptr ? *Result : 0.f;
	}
}

bool FVfxIr::HasOperators(const TSharedPtr<FJsonObject>& Block)
{
	if (!Block.IsValid()) { return false; }
	const TArray<TSharedPtr<FJsonValue>>* Bindings = nullptr;
	if (!Block->TryGetArrayField(TEXT("bindings"), Bindings)) { return false; }
	for (const TSharedPtr<FJsonValue>& Entry : *Bindings)
	{
		const TSharedPtr<FJsonObject> Binding = Entry->AsObject();
		if (Binding.IsValid() && Binding->GetStringField(TEXT("src")) == TEXT("register"))
		{
			return true;
		}
	}
	return false;
}

FVfxBound FVfxIr::Binding(const TSharedPtr<FJsonObject>& Block, const TCHAR* Prop) const
{
	FVfxBound Bound;
	if (!Block.IsValid()) { return Bound; }

	const TArray<TSharedPtr<FJsonValue>>* Bindings = nullptr;
	if (!Block->TryGetArrayField(TEXT("bindings"), Bindings)) { return Bound; }

	for (const TSharedPtr<FJsonValue>& Entry : *Bindings)
	{
		const TSharedPtr<FJsonObject> Binding = Entry->AsObject();
		if (!Binding.IsValid() || Binding->GetStringField(TEXT("prop")) != Prop) { continue; }

		Bound.bFound = true;
		Bound.Width = FMath::Max(1, static_cast<int32>(Binding->GetIntegerField(TEXT("width"))));
		const FString Source = Binding->GetStringField(TEXT("src"));

		if (Source == TEXT("const"))
		{
			const int32 At = Binding->GetIntegerField(TEXT("index"));
			Bound.Constant = Constant(At);
			ReadVector(ConstantPool, At, Bound.Width, Bound.Vector);
			return Bound;
		}
		if (Source == TEXT("random"))
		{
			const int32 Lo = Binding->GetIntegerField(TEXT("loIndex"));
			const int32 Hi = Binding->GetIntegerField(TEXT("hiIndex"));
			Bound.bRandom = true;
			Bound.Low = Constant(Lo);
			Bound.High = Constant(Hi);
			Bound.Constant = (Bound.Low + Bound.High) * 0.5f;
			ReadVector(ConstantPool, Lo, Bound.Width, Bound.LowVector);
			ReadVector(ConstantPool, Hi, Bound.Width, Bound.HighVector);
			FMemory::Memcpy(Bound.Vector, Bound.LowVector, sizeof(Bound.Vector));
			return Bound;
		}
		if (Source == TEXT("register"))
		{
			// SAMPLED ACROSS THE EFFECT AND AVERAGED. A Niagara module input is
			// one number; the chain is a function of time. The average is the
			// one number that is wrong in the same way a constant is always
			// wrong about an animation, rather than catastrophically wrong
			// about the magnitude - which is what the zero this used to return
			// was. The caller reports the flattening; see HasOperators.
			Bound.bRegister = true;
			const int32 Register = Binding->GetIntegerField(TEXT("index"));
			const TArray<TSharedPtr<FJsonValue>>* Ops = nullptr;
			if (Block->TryGetArrayField(TEXT("pre"), Ops) && Ops->Num() > 0)
			{
				const float Span = FMath::Max(0.01f, Duration());
				constexpr int32 Samples = 17;
				float Total = 0.f;
				for (int32 i = 0; i < Samples; ++i)
				{
					Total += EvaluateOps(*Ops, Register, Span * i / (Samples - 1),
						[this](int32 Index) { return Constant(Index); });
				}
				Bound.Constant = Total / Samples;
				for (int32 i = 0; i < Bound.Width && i < 4; ++i)
				{
					Bound.Vector[i] = Bound.Constant;
				}
			}
			return Bound;
		}
		if (Source == TEXT("curve") || Source == TEXT("gradient"))
		{
			// THE AUTHORED KEYS, NOT THE BAKED TABLE. The IR carries both,
			// produced together from one source so they cannot drift: the table
			// is a 65-entry Float32Array for the preview's inner loop, and the
			// authored form is key/tangent data. Niagara's FRichCurve is key and
			// tangent data too, so importing the authored form is a field rename
			// rather than a resampling - and a resampled curve would lose the
			// author's ability to edit it on the far side.
			const int32 At = Binding->GetIntegerField(TEXT("index"));
			if (TablePool.IsValidIndex(At))
			{
				const TSharedPtr<FJsonObject> Table = TablePool[At]->AsObject();
				const TSharedPtr<FJsonObject>* Authored = nullptr;
				if (Table.IsValid() && Table->TryGetObjectField(TEXT("authored"), Authored))
				{
					if (Source == TEXT("curve")) { Bound.Curve = *Authored; }
					else { Bound.Gradient = *Authored; }
				}
			}
			Binding->TryGetNumberField(TEXT("scale"), Bound.Scale);
			return Bound;
		}
		// An operator-driven property. There is nothing to read: the value is
		// computed per particle by a chain the plugin cannot reproduce. The
		// caller reports it rather than silently importing a zero.
		return Bound;
	}
	return Bound;
}

TArray<FVector3f> FVfxIr::Points(const TSharedPtr<FJsonObject>& Block) const
{
	// A PATH IS BLOCK DATA, NOT A BINDING. The curve emitter's points are a list
	// whose length the author changes, and a binding is fixed-width and folded
	// into the constant pool, so the compiler carries the list through verbatim
	// instead. It arrives here already in order.
	TArray<FVector3f> Path;
	const TArray<TSharedPtr<FJsonValue>>* Raw = nullptr;
	if (!Block.IsValid() || !Block->TryGetArrayField(TEXT("points"), Raw)) { return Path; }

	for (const TSharedPtr<FJsonValue>& Entry : *Raw)
	{
		const TArray<TSharedPtr<FJsonValue>>* Components = nullptr;
		if (!Entry->TryGetArray(Components) || Components->Num() < 3) { continue; }
		const float Xyz[3] = {
			static_cast<float>((*Components)[0]->AsNumber()),
			static_cast<float>((*Components)[1]->AsNumber()),
			static_cast<float>((*Components)[2]->AsNumber()),
		};
		Path.Add(FVfxConvert::Vector(Xyz));
	}
	return Path;
}

FString FVfxIr::BlockType(const TSharedPtr<FJsonObject>& Block)
{
	return Block.IsValid() ? Block->GetStringField(TEXT("srcBlockType")) : FString();
}

FString FVfxIr::Mode(const TSharedPtr<FJsonObject>& Block, const TCHAR* Name,
	const TCHAR* Fallback)
{
	const TSharedPtr<FJsonObject>* Modes = nullptr;
	if (Block.IsValid() && Block->TryGetObjectField(TEXT("modes"), Modes))
	{
		FString Value;
		if ((*Modes)->TryGetStringField(Name, Value) && !Value.IsEmpty()) { return Value; }
	}
	return Fallback;
}

float FVfxIr::Duration() const
{
	const TSharedPtr<FJsonObject>* Effect = nullptr;
	if (IrObject.IsValid() && IrObject->TryGetObjectField(TEXT("effect"), Effect))
	{
		double Value = 0;
		if ((*Effect)->TryGetNumberField(TEXT("duration"), Value))
		{
			return static_cast<float>(Value);
		}
	}
	return 1.f;
}

bool FVfxIr::Loops() const
{
	const TSharedPtr<FJsonObject>* Effect = nullptr;
	if (IrObject.IsValid() && IrObject->TryGetObjectField(TEXT("effect"), Effect))
	{
		bool Value = false;
		if ((*Effect)->TryGetBoolField(TEXT("loop"), Value)) { return Value; }
	}
	return true;
}

int32 FVfxIr::Seed() const
{
	const TSharedPtr<FJsonObject>* Effect = nullptr;
	if (IrObject.IsValid() && IrObject->TryGetObjectField(TEXT("effect"), Effect))
	{
		int32 Value = 0;
		if ((*Effect)->TryGetNumberField(TEXT("seed"), Value)) { return Value; }
	}
	return 0;
}

int32 FVfxIr::AssetSlot(const TSharedPtr<FJsonObject>& Block, const TCHAR* Slot)
{
	if (!Block.IsValid()) { return -1; }
	const TSharedPtr<FJsonObject>* Slots = nullptr;
	if (!Block->TryGetObjectField(TEXT("assetSlots"), Slots)) { return -1; }
	int32 Index = -1;
	return (*Slots)->TryGetNumberField(Slot, Index) ? Index : -1;
}
