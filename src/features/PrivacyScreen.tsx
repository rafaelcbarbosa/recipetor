import { ScreenHeader } from "./ui";

export function PrivacyScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="app feature-app">
      <div className="screen privacy-screen">
        <ScreenHeader title="Privacy & terms" onBack={onBack} />

        <section className="feature-card">
          <h2>What we store</h2>
          <p className="feature-lede">
            Accounts belong to parents — kids never sign up. We store your email, an optional display name,
            and the first names or nicknames you add for your children in a class.
          </p>
        </section>

        <section className="feature-card">
          <h2>What is public</h2>
          <p className="feature-lede">
            Only recipes you explicitly mark <strong>Public</strong> appear in Discover and on shareable
            recipe pages. A public recipe shows the dish, ingredients, steps, and the original Instagram or
            Facebook source. It is always credited to “Shared by a family”.
          </p>
          <p className="helper">
            Your child's name, your class's name, and your email or display name never appear on anything
            public — not in the page, the share preview, or the photo alt text.
          </p>
        </section>

        <section className="feature-card">
          <h2>Class content</h2>
          <p className="feature-lede">
            Cook-Along photos and notes are visible only to approved families in that class. Class pages are
            hidden from search engines, and class photos use links that expire after an hour.
          </p>
        </section>

        <section className="feature-card">
          <h2>Your controls</h2>
          <ul className="privacy-list">
            <li>Change a recipe's visibility or make it private again at any time.</li>
            <li>Delete your own posts and recipes — the public page and photo go with them.</li>
            <li>Class admins can hide any post; removing a child removes their posts from the class.</li>
            <li>You can leave a class or delete your account whenever you like.</li>
          </ul>
        </section>

        <section className="feature-card">
          <h2>Fair use</h2>
          <p className="feature-lede">
            Only post photos of your own family's cooking, and only share recipes you have the right to
            share. Recipes taken from Instagram or Facebook keep their original source credit. Report
            anything that shouldn't be public and the site admin will review it.
          </p>
        </section>

        <p className="helper">
          Questions about your data? Contact the site admin through the report button or your class admin.
        </p>
      </div>
    </div>
  );
}
