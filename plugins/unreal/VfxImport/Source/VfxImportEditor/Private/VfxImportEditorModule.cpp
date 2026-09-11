// The editor module, and the menu item an author actually uses.
//
// WHY A C++ PLUGIN AND NOT A PYTHON SCRIPT. Phase 0 measured it (see
// plugins/unreal/Spikes/): `UNiagaraExternalEditUtilities` is the API that can
// create a Niagara system and add emitters, renderers and modules to it - and
// its header carries ZERO `UFUNCTION` macros, so nothing on it is exposed to
// Blueprint or Python, despite the class deriving from UBlueprintFunctionLibrary
// and its own comment claiming to be "C++ and Blueprint accessible". Python can
// create an empty system asset and nothing else; UNiagaraSystem exposes no
// emitter members to reflection at all.
//
// So the importer is a compiled editor module. That is a heavier deliverable
// than a script, and it buys something the plan did not expect: Niagara CAN be
// authored structurally, so an imported effect gets real emitters and real
// module stacks rather than parameters bound onto a template.
#include "Modules/ModuleManager.h"
#include "Misc/Paths.h"
#include "Misc/MessageDialog.h"
#include "ToolMenus.h"
#include "DesktopPlatformModule.h"
#include "IDesktopPlatform.h"
#include "Framework/Application/SlateApplication.h"

#include "VfxBundleImporter.h"
#include "VfxImportReport.h"

#define LOCTEXT_NAMESPACE "VfxImport"

DEFINE_LOG_CATEGORY_STATIC(LogVfxImport, Log, All);

namespace
{
	void ImportBundleInteractively()
	{
		IDesktopPlatform* Desktop = FDesktopPlatformModule::Get();
		if (Desktop == nullptr) { return; }

		const void* ParentWindow = FSlateApplication::IsInitialized()
			&& FSlateApplication::Get().GetActiveTopLevelWindow().IsValid()
			? FSlateApplication::Get().GetActiveTopLevelWindow()->GetNativeWindow()->GetOSWindowHandle()
			: nullptr;

		// A FOLDER, not a file. The bundle is a folder holding manifest.json
		// plus an assets tree, and asking for the .json would let someone pick
		// one out of its folder and lose the assets beside it.
		FString Folder;
		if (!Desktop->OpenDirectoryDialog(ParentWindow,
			TEXT("Choose an exported VFX bundle folder"), FPaths::ProjectDir(), Folder))
		{
			return;
		}

		FVfxImportReport Report;
		FString AssetPath;
		const bool bOk = FVfxBundleImporter::Import(Folder, TEXT("/Game/ImportedVfx"),
			Report, AssetPath);

		TArray<FString> Lines;
		Report.ToText().ParseIntoArrayLines(Lines, /*bCullEmpty*/ false);
		for (const FString& Line : Lines)
		{
			UE_LOG(LogVfxImport, Display, TEXT("%s"), *Line);
		}

		// THE REPORT IS SHOWN, not just logged. An author who is told "imported"
		// and nothing else has no way to know that their mesh renderer, their
		// blend mode and their textures did not come across - and will conclude
		// the effect is broken rather than incomplete.
		const FText Message = FText::FromString(FString::Printf(
			TEXT("%s\n\n%s\n\nThe full report is in the Output Log under LogVfxImport."),
			bOk ? *FString::Printf(TEXT("Imported to %s"), *AssetPath)
				: TEXT("Import failed."),
			*Report.Summary()));
		FMessageDialog::Open(EAppMsgType::Ok, Message,
			LOCTEXT("VfxImportTitle", "Import VFX Bundle"));
	}

	void RegisterMenu()
	{
		FToolMenuOwnerScoped Owner(TEXT("VfxImport"));
		UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
		if (Menu == nullptr) { return; }

		FToolMenuSection& Section = Menu->FindOrAddSection(TEXT("VfxImport"),
			LOCTEXT("VfxSection", "3D Gen Studio"));
		Section.AddMenuEntry(
			TEXT("ImportVfxBundle"),
			LOCTEXT("ImportVfxBundle", "Import VFX Bundle..."),
			LOCTEXT("ImportVfxBundleTip",
				"Build a Niagara system from a VFX bundle exported by 3D Gen Studio."),
			FSlateIcon(),
			FUIAction(FExecuteAction::CreateStatic(&ImportBundleInteractively)));
	}
}

class FVfxImportEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		// Deferred: tool menus are not registered yet at module startup, and
		// extending one now would silently do nothing.
		UToolMenus::RegisterStartupCallback(
			FSimpleMulticastDelegate::FDelegate::CreateStatic(&RegisterMenu));
		UE_LOG(LogVfxImport, Log, TEXT("VfxImportEditor loaded"));
	}

	virtual void ShutdownModule() override
	{
		UToolMenus::UnRegisterStartupCallback(this);
		UToolMenus::UnregisterOwner(this);
	}
};

IMPLEMENT_MODULE(FVfxImportEditorModule, VfxImportEditor);

#undef LOCTEXT_NAMESPACE
