export const metadata = { title: "PT RCM" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <p>Synthetic data only. Fixture clearinghouse. Not for live claims.</p>
        {children}
      </body>
    </html>
  );
}
