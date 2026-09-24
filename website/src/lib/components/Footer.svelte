<script lang="ts">
    import { Button } from '$lib/components/ui/button';
    import LanguageSelect from '$lib/components/LanguageSelect.svelte';
    import ModeSwitch from '$lib/components/ModeSwitch.svelte';
    import Logo from '$lib/components/Logo.svelte';
    import { BookOpenText, House, Map } from '@lucide/svelte';
    import { i18n } from '$lib/i18n.svelte';
    import { getURLForLanguage } from '$lib/utils';
</script>

<footer class="w-full px-12 py-10 border-t flex flex-col items-center">
    <div class="w-full max-w-5xl flex flex-row flex-wrap justify-between gap-x-10 gap-y-6">
        <div class="grow flex flex-col items-start">
            <Logo class="h-8" width="153" />
            <Button
                variant="link"
                class="h-6 px-0 has-[>svg]:px-0 text-muted-foreground"
                href="https://github.com/a052/GoTrails/blob/main/LICENSE"
                target="_blank"
            >
                MIT © 2026 GoTrails
            </Button>
            <div class="mt-3 flex flex-row gap-1.5">
                <LanguageSelect />
                <ModeSwitch />
            </div>
        </div>
        <div class="grow max-w-2xl flex flex-row flex-wrap justify-between gap-x-10 gap-y-6">
            <!-- empty spacer: keeps the Website column in the middle slot and Contribute right-aligned -->
            <div></div>
            <div class="flex flex-col items-start gap-1">
                <span class="font-semibold">{i18n._('homepage.website')}</span>
                <Button
                    variant="link"
                    class="h-6 px-0 has-[>svg]:px-0 text-muted-foreground"
                    href={getURLForLanguage(i18n.lang, '/')}
                >
                    <House size="16" />
                    {i18n._('homepage.home')}
                </Button>
                <Button
                    data-sveltekit-reload
                    variant="link"
                    class="h-6 px-0 has-[>svg]:px-0 text-muted-foreground"
                    href={getURLForLanguage(i18n.lang, '/app')}
                >
                    <Map size="16" />
                    {i18n._('homepage.app')}
                </Button>
                <Button
                    variant="link"
                    class="h-6 px-0 has-[>svg]:px-0 text-muted-foreground"
                    href={getURLForLanguage(i18n.lang, '/help')}
                >
                    <BookOpenText size="16" />
                    {i18n._('menu.help')}
                </Button>
            </div>
            <div class="flex flex-col items-start gap-1">
                <span class="font-semibold">{i18n._('homepage.contribute')}</span>
                <Button
                    variant="link"
                    class="h-6 px-0 has-[>svg]:px-0 text-muted-foreground"
                    href="https://github.com/a052/GoTrails"
                    target="_blank"
                >
                    <Logo company="github" class="h-4 fill-muted-foreground" />
                    {i18n._('homepage.github')}
                </Button>
            </div>
        </div>
    </div>
</footer>
