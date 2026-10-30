cask "marpora" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/farvisun/marpora/releases/download/v#{version}/Marpora_#{version}_universal.dmg"
  name "Marpora"
  desc "Markdown slide editor"
  homepage "https://farvisun.github.io/marpora/"

  # The built-in updater installs new versions in place.
  auto_updates true
  depends_on macos: :monterey

  app "Marpora.app"

  # Ad-hoc signed, not notarized: without this macOS refuses the first launch.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Marpora.app"]
  end

  uninstall quit: "app.marpora.editor"

  zap trash: [
    "~/Library/Application Support/app.marpora.editor",
    "~/Library/Caches/app.marpora.editor",
    "~/Library/Preferences/app.marpora.editor.plist",
    "~/Library/WebKit/app.marpora.editor",
  ]
end
