export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`flex  w-screen h-screen items-center justify-center overflow-auto ${className}`}
    >
      <div className="bg-white max-w-[375px] w-[375px] h-full relative">{children}</div>
    </div>
  );
}
